import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPANY_ID, type UserCompanySummaryDto } from "@erp/shared";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { BranchProvider } from "@/contexts/BranchContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { NotificationBell } from "@/components/layout/NotificationBell";
import { CompanySwitcher } from "@/components/layout/CompanySwitcher";
import type { User } from "@/types";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

const comp1: UserCompanySummaryDto = {
  id: DEFAULT_COMPANY_ID,
  code: "COMP-01",
  name: "Primary Corp",
  role: "admin",
  customRoleId: null,
  customRoleName: "Admin",
  isDefault: true,
  isActive: true,
};

const comp2: UserCompanySummaryDto = {
  id: "00000000-0000-4000-8000-000000000002",
  code: "COMP-02",
  name: "Subsidiary LLC",
  role: "admin",
  customRoleId: null,
  customRoleName: "Admin",
  isDefault: false,
  isActive: true,
};

function makeAdminUser(companies: UserCompanySummaryDto[] = [comp1]): User {
  return {
    id: "admin-1",
    name: "Root Admin",
    email: "admin@erp.test",
    role: "admin",
    branchScopeMode: "all",
    activeCompanyId: companies[0]?.id ?? DEFAULT_COMPANY_ID,
    companies,
    permissions: {
      products: { view: true, create: true, edit: true, delete: true, approve: true },
    },
  };
}

function MfaTestHarness() {
  const { user, mfaRequired, mfaChallengeToken, login, verifyMfaLogin } = useAuth();
  return (
    <div>
      <span data-testid="auth-user">{user ? user.email : "anonymous"}</span>
      <span data-testid="mfa-required">{String(mfaRequired)}</span>
      <span data-testid="mfa-token">{mfaChallengeToken ?? "none"}</span>
      <button type="button" onClick={() => void login("admin@erp.test", "secret")}>
        Trigger Login
      </button>
      <button type="button" onClick={() => void verifyMfaLogin("123456")}>
        Submit MFA
      </button>
    </div>
  );
}

describe("Core Shell Deduplication, MFA Challenge & CompanySwitcher", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it("fires <= 5 initial GET requests across Auth, Branch, Settings, Permissions, and NotificationBell", async () => {
    const adminUser = makeAdminUser([comp1]);
    const getCalls: string[] = [];

    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (!opts?.method || opts.method === "GET") {
        getCalls.push(url);
      }
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/branches") {
        return Promise.resolve({
          branches: [
            {
              id: "br-1",
              code: "HQ",
              name: "HQ Warehouse",
              branchType: "hq_warehouse",
              location: "Cairo",
              isDefault: true,
              isActive: true,
            },
          ],
        });
      }
      if (url === "/api/settings/company") {
        return Promise.resolve({
          company: {
            companyName: "Primary Corp",
            legalName: null,
            taxRegistrationNumber: null,
            baseCurrency: "USD",
            einvoicingMode: "none",
            address: null,
            phone: null,
            email: null,
          },
          taxCodes: [],
        });
      }
      if (url === "/api/settings/preferences") {
        return Promise.resolve({
          preferences: { activeBranchId: null, preferencesJson: { appearance: "light" } },
        });
      }
      if (url.startsWith("/api/notifications")) {
        return Promise.resolve({ notifications: [] });
      }
      return Promise.resolve({});
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <AuthProvider>
            <BranchProvider>
              <SettingsProvider>
                <PermissionsProvider>
                  <NotificationBell />
                </PermissionsProvider>
              </SettingsProvider>
            </BranchProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(getCalls).toContain("/api/branches");
      expect(getCalls).toContain("/api/settings/company");
      expect(getCalls).toContain("/api/settings/preferences");
      expect(getCalls.some((u) => u.startsWith("/api/notifications"))).toBe(true);
    });

    expect(getCalls.length).toBeLessThanOrEqual(5);
    expect(getCalls.filter((u) => u === "/api/settings/preferences")).toHaveLength(1);
    expect(getCalls).not.toContain("/api/branches?scope=directory");
    expect(getCalls).not.toContain("/api/roles/permissions");
  });

  it("handles MFA login challenge and completes via verifyMfaLogin", async () => {
    const adminUser = makeAdminUser([comp1]);
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: null });
      if (url === "/api/auth/login") {
        return Promise.resolve({ mfaRequired: true, mfaChallengeToken: "mfa-tok-123" });
      }
      if (url === "/api/auth/mfa/verify-login") {
        return Promise.resolve({ user: { ...adminUser, mfaEnabled: true } });
      }
      return Promise.resolve({});
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MfaTestHarness />
        </AuthProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("auth-user")).toHaveTextContent("anonymous");
    });

    fireEvent.click(screen.getByRole("button", { name: "Trigger Login" }));

    await waitFor(() => {
      expect(screen.getByTestId("mfa-required")).toHaveTextContent("true");
      expect(screen.getByTestId("mfa-token")).toHaveTextContent("mfa-tok-123");
    });
    expect(screen.getByTestId("auth-user")).toHaveTextContent("anonymous");

    fireEvent.click(screen.getByRole("button", { name: "Submit MFA" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-user")).toHaveTextContent("admin@erp.test");
      expect(screen.getByTestId("mfa-required")).toHaveTextContent("false");
    });
  });

  it("CompanySwitcher renders single badge for 1 company and switches active company + clears cache for >1 companies", async () => {
    const singleUser = makeAdminUser([comp1]);
    apiRequestMock.mockResolvedValue({ user: singleUser });

    const queryClient1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={queryClient1}>
        <AuthProvider>
          <CompanySwitcher />
        </AuthProvider>
      </QueryClientProvider>
    );

    const singleBadge = await screen.findByTestId("company-switcher-single");
    expect(singleBadge).toHaveTextContent("Primary Corp");
    expect(singleBadge).toHaveTextContent("COMP-01");
    unmount();

    const multiUser = makeAdminUser([comp1, comp2]);
    const switchedUser: User = { ...multiUser, activeCompanyId: comp2.id };
    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: multiUser });
      if (url === "/api/auth/switch-company" && opts?.method === "POST") {
        return Promise.resolve({ user: switchedUser });
      }
      return Promise.resolve({});
    });

    const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient2.setQueryData(["stale-tenant-key"], { secret: "comp1-data" });
    const clearSpy = vi.spyOn(queryClient2, "clear");

    render(
      <QueryClientProvider client={queryClient2}>
        <AuthProvider>
          <CompanySwitcher />
        </AuthProvider>
      </QueryClientProvider>
    );

    const trigger = await screen.findByTestId("company-switcher-select");
    fireEvent.click(trigger);

    const option2 = await screen.findByText(/COMP-02 · Subsidiary LLC/i);
    fireEvent.click(option2);

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/auth/switch-company", {
        method: "POST",
        body: { companyId: comp2.id },
      });
    });
    expect(clearSpy).toHaveBeenCalled();
  });
});
