import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { RequirePermission } from "@/components/auth/RequirePermission";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { CommandPalette } from "@/components/CommandPalette";
import type { User } from "@/types";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

function buildStandardUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    name: "Jane Cashier",
    email: "jane@erp.test",
    role: "user",
    permissions: {
      products: { view: true, create: false, edit: false, delete: false, approve: false },
      sales: { view: true, create: true, edit: false, delete: false, approve: false },
      audit: { view: false, create: false, edit: false, delete: false, approve: false },
      roles: { view: false, create: false, edit: false, delete: false, approve: false },
      settings: { view: false, create: false, edit: false, delete: false, approve: false },
    },
    ...overrides,
  };
}

function renderWithShell(ui: React.ReactElement, initialEntries = ["/"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <PermissionsProvider>{ui}</PermissionsProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("RequirePermission, ProtectedRoute & CommandPalette", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
  });

  it("RequirePermission renders children when allowed, hides in hide mode, and renders 403 card in page mode", async () => {
    const user = buildStandardUser();
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user });
      return Promise.resolve({});
    });

    renderWithShell(
      <div>
        <RequirePermission module="products" action="view">
          <div>Visible Catalog</div>
        </RequirePermission>
        <RequirePermission module="products" action="delete" mode="hide">
          <div>Hidden Delete Action</div>
        </RequirePermission>
        <RequirePermission module="audit" action="view" mode="page">
          <div>Audit Secret Page</div>
        </RequirePermission>
      </div>
    );

    await waitFor(() => {
      expect(screen.getByText("Visible Catalog")).toBeInTheDocument();
    });
    expect(screen.queryByText("Hidden Delete Action")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit Secret Page")).not.toBeInTheDocument();

    const alertCard = screen.getByRole("alert");
    expect(alertCard).toHaveTextContent("403");
    expect(alertCard).toHaveTextContent("Access Denied");
    expect(screen.getByRole("link", { name: /Back to Dashboard/i })).toHaveAttribute("href", "/");
  });

  it("RequirePermission enforces roles override and custom fallback", async () => {
    const user = buildStandardUser({ role: "manager" });
    apiRequestMock.mockResolvedValue({ user });

    renderWithShell(
      <RequirePermission
        module="products"
        action="view"
        roles={["admin"]}
        fallback={<div>Admin Only Notice</div>}
      >
        <div>Admin Panel</div>
      </RequirePermission>
    );

    await waitFor(() => {
      expect(screen.getByText("Admin Only Notice")).toBeInTheDocument();
    });
    expect(screen.queryByText("Admin Panel")).not.toBeInTheDocument();
  });

  it("ProtectedRoute redirects unauthenticated users to /login and unauthorized users to /", async () => {
    apiRequestMock.mockResolvedValue({ user: null });

    const { unmount } = renderWithShell(
      <Routes>
        <Route path="/login" element={<div>Login Page</div>} />
        <Route
          path="/secret"
          element={
            <ProtectedRoute requiredModule="audit">
              <div>Secret Audit</div>
            </ProtectedRoute>
          }
        />
      </Routes>,
      ["/secret"]
    );

    await waitFor(() => {
      expect(screen.getByText("Login Page")).toBeInTheDocument();
    });
    unmount();

    const standardUser = buildStandardUser();
    apiRequestMock.mockResolvedValue({ user: standardUser });

    renderWithShell(
      <Routes>
        <Route path="/" element={<div>Dashboard Home</div>} />
        <Route
          path="/secret"
          element={
            <ProtectedRoute requiredModule="audit">
              <div>Secret Audit</div>
            </ProtectedRoute>
          }
        />
      </Routes>,
      ["/secret"]
    );

    await waitFor(() => {
      expect(screen.getByText("Dashboard Home")).toBeInTheDocument();
    });
    expect(screen.queryByText("Secret Audit")).not.toBeInTheDocument();
  });

  it("CommandPalette opens on Ctrl+K, filters quick nav by permissions, queries /api/search, and navigates on selection", async () => {
    const user = buildStandardUser();
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user });
      if (url.startsWith("/api/search")) {
        return Promise.resolve({
          query: "widget",
          results: [
            {
              type: "product",
              id: "prod-1",
              title: "Widget Pro",
              subtitle: "SKU-WID-01",
              route: "/products",
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    renderWithShell(
      <>
        <CommandPalette />
        <Routes>
          <Route path="/" element={<div>Home Route</div>} />
          <Route path="/products" element={<div>Products Destination</div>} />
        </Routes>
      </>
    );

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith("/api/auth/me");
    });

    // Open via Ctrl+K shortcut
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = await screen.findByPlaceholderText(/Search products, customers, invoices, or pages/i);
    expect(input).toBeInTheDocument();

    // Standard user can see Products, cannot see Audit Log or Roles & Permissions
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.queryByText("Audit Log")).not.toBeInTheDocument();
    expect(screen.queryByText("Roles & Permissions")).not.toBeInTheDocument();

    // Type search query -> debounced GET /api/search?q=widget&limit=20
    fireEvent.change(input, { target: { value: "widget" } });

    await waitFor(
      () => {
        expect(apiRequestMock).toHaveBeenCalledWith("/api/search?q=widget&limit=20");
      },
      { timeout: 1500 }
    );

    const resultItem = await screen.findByText("Widget Pro");
    expect(screen.getByText("SKU-WID-01")).toBeInTheDocument();

    fireEvent.click(resultItem);

    await waitFor(() => {
      expect(screen.getByText("Products Destination")).toBeInTheDocument();
    });
  });
});
