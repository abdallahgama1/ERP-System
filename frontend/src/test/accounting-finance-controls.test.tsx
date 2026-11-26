import i18n, { ensureLocaleLoaded } from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { SidebarProvider } from "@/components/ui/sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { AppSidebar } from "@/components/layout/AppSidebar";
import AccountingSetupHealth from "@/pages/accounting/AccountingSetupHealth";
import AccountingReconciliation from "@/pages/accounting/AccountingReconciliation";
import FiscalPeriods from "@/pages/accounting/FiscalPeriods";
import type { User } from "@/types";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

function buildUser(role: "admin" | "manager" = "admin"): User {
  return {
    id: role === "admin" ? "admin-1" : "mgr-1",
    name: role === "admin" ? "Admin User" : "Manager User",
    email: role === "admin" ? "admin@erp.test" : "mgr@erp.test",
    role,
    permissions: {
      accounting: { view: true, create: true, edit: true, delete: false, approve: true },
      fixed_assets: { view: true, create: false, edit: false, delete: false, approve: false },
      treasury: { view: true, create: false, edit: false, delete: false, approve: false },
      expenses: { view: true, create: false, edit: false, delete: false, approve: false },
    },
  };
}

function renderWithProviders(ui: React.ReactElement, initialEntries = ["/"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <SettingsProvider>
            <PermissionsProvider>{ui}</PermissionsProvider>
          </SettingsProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Finance Controls Admin UI (Setup Health, Reconciliation, Fiscal Reopen, Nav & RTL)", () => {
  beforeEach(async () => {
    apiRequestMock.mockReset();
    await i18n.changeLanguage("en");
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
    document.documentElement.dir = "ltr";
    document.documentElement.lang = "en";
  });

  it("1. AccountingSetupHealth renders missing/type_mismatch/inactive issues with colliding details and remaps via PUT /api/accounting/mappings", async () => {
    let remapped = false;
    const adminUser = buildUser("admin");

    apiRequestMock.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/accounting/accounts") {
        return Promise.resolve({
          accounts: [
            { id: "acct-eq-3101", code: "3101", name: "Retained Earnings (Alt)", accountType: "equity", normalBalance: "credit", parentId: null, description: null, isSystem: false, isActive: true },
            { id: "acct-rev-3100", code: "3100", name: "Legacy Revenue", accountType: "revenue", normalBalance: "credit", parentId: null, description: null, isSystem: false, isActive: true },
          ],
        });
      }
      if (url === "/api/accounting/mappings" && opts?.method === "PUT") {
        remapped = true;
        return Promise.resolve({ mapping: opts.body });
      }
      if (url === "/api/accounting/setup-health") {
        if (remapped) {
          return Promise.resolve({ healthy: true, totalMappings: 15, validMappings: 15, issues: [] });
        }
        return Promise.resolve({
          healthy: false,
          totalMappings: 15,
          validMappings: 12,
          issues: [
            {
              mappingKey: "retained_earnings",
              expectedCode: "3100",
              expectedName: "Retained Earnings",
              expectedAccountType: "equity",
              status: "missing",
              boundAccountId: null,
              boundAccountCode: null,
              boundAccountName: null,
              boundAccountType: null,
              collidingAccountCode: "3100",
              collidingAccountName: "Legacy Revenue",
              collidingAccountType: "revenue",
              instructions: "Account code '3100' is already used by 'Legacy Revenue' (type 'revenue').",
            },
            {
              mappingKey: "realized_fx",
              expectedCode: "5600",
              expectedName: "Realized FX Gain/Loss",
              expectedAccountType: "expense",
              status: "type_mismatch",
              boundAccountId: "acct-bad",
              boundAccountCode: "5600",
              boundAccountName: "Custom Asset",
              boundAccountType: "asset",
              collidingAccountCode: "5600",
              collidingAccountName: "Custom Asset",
              collidingAccountType: "asset",
              instructions: "Rebind realized_fx to an expense account.",
            },
            {
              mappingKey: "unrealized_fx",
              expectedCode: "5610",
              expectedName: "Unrealized FX Gain/Loss",
              expectedAccountType: "expense",
              status: "inactive",
              boundAccountId: "acct-inact",
              boundAccountCode: "5610",
              boundAccountName: "Dormant FX",
              boundAccountType: "expense",
              collidingAccountCode: null,
              collidingAccountName: null,
              collidingAccountType: null,
              instructions: "Reactivate or rebind unrealized_fx.",
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    renderWithProviders(<AccountingSetupHealth />);

    await waitFor(() => {
      expect(screen.getByTestId("setup-issue-row-retained_earnings")).toBeInTheDocument();
      expect(screen.getByTestId("setup-issue-row-realized_fx")).toBeInTheDocument();
      expect(screen.getByTestId("setup-issue-row-unrealized_fx")).toBeInTheDocument();
    });

    expect(screen.getByTestId("setup-collision-retained_earnings")).toHaveTextContent("3100 Legacy Revenue");
    expect(screen.getByTestId("setup-health-valid-count")).toHaveTextContent("12 / 15");

    // Click one-click Remap on retained_earnings
    fireEvent.click(screen.getByTestId("remap-btn-retained_earnings"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("retained_earnings");

    // Eligible equity account 3101 is pre-selected -> submit
    fireEvent.click(screen.getByTestId("remap-confirm-btn"));

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/accounting/mappings", {
        method: "PUT",
        body: { mappingKey: "retained_earnings", accountId: "acct-eq-3101" },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("setup-health-clean-card")).toBeInTheDocument();
    });
  });

  it("2. AccountingReconciliation renders all 8 control accounts with pass/fail and passes asOfDate query parameter", async () => {
    const adminUser = buildUser("admin");
    const sampleItems = [
      { key: "accounts_receivable", label: "Accounts Receivable", glAccountCode: "1100", glAccountName: "Accounts Receivable", subledgerBalance: 5000, glBalance: 5000, variance: 0, isReconciled: true },
      { key: "accounts_payable", label: "Accounts Payable", glAccountCode: "2000", glAccountName: "Accounts Payable", subledgerBalance: 3000, glBalance: 3000, variance: 0, isReconciled: true },
      { key: "inventory_asset", label: "Inventory Asset", glAccountCode: "1200", glAccountName: "Inventory", subledgerBalance: 12000, glBalance: 11950, variance: 50, isReconciled: false, details: "Manual adjustment pending" },
      { key: "output_vat", label: "Output VAT", glAccountCode: "2300", glAccountName: "Output VAT", subledgerBalance: 742, glBalance: 742, variance: 0, isReconciled: true },
      { key: "input_vat", label: "Input VAT", glAccountCode: "1300", glAccountName: "Input VAT", subledgerBalance: 693, glBalance: 693, variance: 0, isReconciled: true },
      { key: "fixed_assets_cost", label: "Fixed Assets Cost", glAccountCode: "1500", glAccountName: "Fixed Assets — Cost", subledgerBalance: 12000, glBalance: 12000, variance: 0, isReconciled: true },
      { key: "accumulated_depreciation", label: "Accumulated Depreciation", glAccountCode: "1510", glAccountName: "Accumulated Depreciation", subledgerBalance: 200, glBalance: 200, variance: 0, isReconciled: true },
      { key: "treasury", label: "Treasury Accounts", glAccountCode: "1030+", glAccountName: "Treasury Control", subledgerBalance: 40000, glBalance: 40000, variance: 0, isReconciled: true },
    ];

    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url.startsWith("/api/accounting/reports/reconciliation")) {
        const match = url.match(/asOfDate=([^&]+)/);
        return Promise.resolve({
          asOfDate: match ? decodeURIComponent(match[1]) : null,
          items: sampleItems,
          treasuryAccounts: [],
          allReconciled: false,
        });
      }
      return Promise.resolve({});
    });

    renderWithProviders(<AccountingReconciliation />);

    await waitFor(() => {
      expect(screen.getByTestId("reconciliation-pass-count")).toHaveTextContent("7 / 8");
    });

    for (const item of sampleItems) {
      expect(screen.getByTestId(`reconciliation-row-${item.key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("reconciliation-status-accounts_receivable")).toHaveTextContent("Pass");
    expect(screen.getByTestId("reconciliation-status-inventory_asset")).toHaveTextContent("Fail");

    fireEvent.change(screen.getByTestId("reconciliation-as-of-input"), {
      target: { value: "2026-06-30" },
    });

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        "/api/accounting/reports/reconciliation?asOfDate=2026-06-30"
      );
      expect(screen.getByTestId("reconciliation-as-of-display")).toHaveTextContent("2026-06-30");
    });
  });

  it("3. FiscalPeriods Reopen action is admin-only, shows consequences, requires reason, and surfaces LATER_FISCAL_YEAR_CLOSED", async () => {
    const adminUser = buildUser("admin");
    const fiscalYears = [
      {
        id: "fy-2024",
        name: "FY 2024",
        startDate: "2024-01-01T00:00:00.000Z",
        endDate: "2024-12-31T00:00:00.000Z",
        status: "closed",
        periods: [],
      },
    ];

    apiRequestMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/accounting/fiscal-years") return Promise.resolve({ fiscalYears });
      if (url === "/api/accounting/fiscal-years/fy-2024/reopen" && opts?.method === "POST") {
        return Promise.reject(
          new Error("Cannot reopen 'FY 2024' while later fiscal year 'FY 2025' is closed. Reopen 'FY 2025' first.")
        );
      }
      return Promise.resolve({});
    });

    const { unmount } = renderWithProviders(<FiscalPeriods />);

    const reopenBtn = await screen.findByTestId("reopen-fy-btn-fy-2024");
    fireEvent.click(reopenBtn);

    const consequences = await screen.findByTestId("reopen-consequences-box");
    expect(consequences).toHaveTextContent("2024-12-31");
    expect(consequences).toHaveTextContent(/Unlocks all monthly periods/i);
    expect(consequences).toHaveTextContent(/audit-log/i);

    const confirmBtn = screen.getByTestId("reopen-confirm-btn");
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId("reopen-reason-input"), {
      target: { value: "Audit adjustment for FY 2024" },
    });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);

    const errAlert = await screen.findByTestId("reopen-error-alert");
    expect(errAlert).toHaveTextContent("Cannot reopen 'FY 2024' while later fiscal year 'FY 2025' is closed");
    unmount();

    // Non-admin (manager) must NOT see the Reopen button
    const managerUser = buildUser("manager");
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: managerUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/accounting/fiscal-years") return Promise.resolve({ fiscalYears });
      return Promise.resolve({});
    });

    renderWithProviders(<FiscalPeriods />);
    await waitFor(() => {
      expect(screen.getByText("FY 2024")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("reopen-fy-btn-fy-2024")).not.toBeInTheDocument();
  });

  it("4. Sidebar and CommandPalette gate admin-only finance controls and render Arabic RTL cleanly", async () => {
    const adminUser = buildUser("admin");
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      return Promise.resolve({ results: [] });
    });

    const { unmount } = renderWithProviders(
      <SidebarProvider>
        <AppSidebar />
        <CommandPalette open={true} showTrigger={false} />
      </SidebarProvider>,
      ["/accounting/periods"]
    );

    await waitFor(() => {
      expect(screen.getAllByText("Fiscal Periods").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Subledger Reconciliation").length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByText("Setup Health").length).toBeGreaterThanOrEqual(1);
    });
    unmount();

    // Non-admin manager sees Fiscal Periods, NOT Setup Health or Subledger Reconciliation
    const managerUser = buildUser("manager");
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: managerUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      return Promise.resolve({ results: [] });
    });

    const { unmount: unmountMgr } = renderWithProviders(
      <SidebarProvider>
        <AppSidebar />
        <CommandPalette open={true} showTrigger={false} />
      </SidebarProvider>,
      ["/accounting/periods"]
    );

    await waitFor(() => {
      expect(screen.getAllByText("Fiscal Periods").length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByText("Subledger Reconciliation")).not.toBeInTheDocument();
    expect(screen.queryByText("Setup Health")).not.toBeInTheDocument();
    unmountMgr();

    // Arabic RTL verification
    await ensureLocaleLoaded("ar");
    await i18n.changeLanguage("ar");
    document.documentElement.dir = "rtl";
    document.documentElement.lang = "ar";

    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: adminUser });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: { language: "ar" } });
      if (url === "/api/accounting/setup-health") {
        return Promise.resolve({ healthy: true, totalMappings: 15, validMappings: 15, issues: [] });
      }
      if (url === "/api/accounting/accounts") return Promise.resolve({ accounts: [] });
      return Promise.resolve({});
    });

    renderWithProviders(<AccountingSetupHealth />);
    expect(document.documentElement.dir).toBe("rtl");
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /صحة إعداد المحاسبة/ })
      ).toBeInTheDocument();
    });
  });
});
