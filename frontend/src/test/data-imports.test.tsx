import i18n, { ensureLocaleLoaded } from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/contexts/AuthContext";
import { BranchProvider } from "@/contexts/BranchContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { SettingsProvider } from "@/contexts/SettingsContext";
import DataImports from "@/pages/admin/DataImports";
import SalesVsPurchases from "@/pages/reports/SalesVsPurchases";
import ARAging from "@/pages/reports/ARAging";
import type { User } from "@/types";

const apiRequestMock = vi.fn();

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

function buildAdmin(): User {
  return {
    id: "admin-1",
    name: "Cutover Admin",
    email: "admin@erp.test",
    role: "admin",
    permissions: {
      accounting: { view: true, create: true, edit: true, delete: false, approve: true },
      sales: { view: true, create: true, edit: true, delete: false, approve: true },
      purchases: { view: true, create: true, edit: true, delete: false, approve: true },
      reports: { view: true, create: false, edit: false, delete: false, approve: false },
    },
  };
}

function renderWithShell(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <BranchProvider>
            <SettingsProvider>
              <PermissionsProvider>{ui}</PermissionsProvider>
            </SettingsProvider>
          </BranchProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("DataImports Admin UI & Opening Document Report Exclusions", () => {
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

  it("1. renders all 8 cutover steps, surfaces reversal button when posted, and renders Arabic RTL", async () => {
    const admin = buildAdmin();
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: admin });
      if (url === "/api/branches") return Promise.resolve({ branches: [{ id: "b1", code: "HQ", name: "Main HQ", isDefault: true }] });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/imports/opening-balances/status") {
        return Promise.resolve({
          hasOpeningJournal: true,
          openingJournalEntryId: "je-open-1",
          openingJournalEntryNumber: "JE-0001",
          cutoverDate: "2026-01-01",
          hasNonOpeningJournals: false,
          canImportOpening: false,
          canReverseOpening: true,
          blockedReason: null,
          counts: {
            openingArInvoices: 2,
            openingApBills: 2,
            openingFixedAssets: 2,
            openingTreasuryAccounts: 2,
            openingStockMovements: 2,
          },
        });
      }
      if (url === "/api/imports/cutover-readiness") {
        return Promise.resolve({
          ready: true,
          status: "PASS",
          checkedAt: "2026-01-01T00:00:00.000Z",
          checks: {
            reconciliation: {
              passed: true,
              totalControls: 8,
              passedControls: 8,
              failingKeys: [],
              summary: "All 8 subledger-to-GL controls reconciled",
            },
            setupHealth: {
              passed: true,
              totalMappings: 28,
              validMappings: 28,
              issueCount: 0,
              summary: "All 28 required GL mappings healthy",
            },
            auditChain: {
              passed: true,
              totalChainedRows: 12,
              firstBrokenId: null,
              summary: "Audit hash chain intact (12 chained rows)",
            },
          },
          reconciliation: { asOfDate: "2026-01-01", allReconciled: true, items: [] },
          setupHealth: { healthy: true, totalMappings: 28, validMappings: 28, issues: [] },
        });
      }
      return Promise.resolve({});
    });

    const { unmount } = renderWithShell(<DataImports />);

    await waitFor(() => {
      expect(screen.getByTestId("cutover-readiness-card")).toBeInTheDocument();
      expect(screen.getByTestId("cutover-readiness-badge")).toHaveTextContent(/PASS/i);
      expect(screen.getByTestId("import-card-chart_of_accounts")).toBeInTheDocument();
      expect(screen.getByTestId("import-card-opening_fixed_assets")).toBeInTheDocument();
      expect(screen.getByTestId("import-card-opening_treasury")).toBeInTheDocument();
      expect(screen.getByTestId("opening-balances-card")).toBeInTheDocument();
      expect(screen.getByTestId("reverse-opening-btn")).toBeInTheDocument();
    });

    // Open Customers import dialog and verify default create-only + explicit updateExisting toggle
    fireEvent.click(screen.getByTestId("open-import-customers"));
    const updateToggle = await screen.findByTestId("csv-update-existing-customers");
    expect(updateToggle).toHaveAttribute("data-state", "unchecked");
    fireEvent.click(updateToggle);
    expect(updateToggle).toHaveAttribute("data-state", "checked");
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByTestId("reverse-opening-btn"));
    expect(await screen.findByTestId("reverse-opening-reason")).toBeInTheDocument();
    unmount();

    await ensureLocaleLoaded("ar");
    await i18n.changeLanguage("ar");
    document.documentElement.dir = "rtl";
    renderWithShell(<DataImports />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /استيراد البيانات والانتقال التشغيلي/ })
      ).toBeInTheDocument();
    });
  });

  it("1b. displays FAIL state on Cutover Readiness card when any control is not clean", async () => {
    const admin = buildAdmin();
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: admin });
      if (url === "/api/branches") return Promise.resolve({ branches: [{ id: "b1", code: "HQ", name: "Main HQ", isDefault: true }] });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/imports/opening-balances/status") {
        return Promise.resolve({
          hasOpeningJournal: false,
          openingJournalEntryId: null,
          openingJournalEntryNumber: null,
          cutoverDate: null,
          hasNonOpeningJournals: false,
          canImportOpening: true,
          canReverseOpening: false,
          blockedReason: null,
          counts: {
            openingArInvoices: 0,
            openingApBills: 0,
            openingFixedAssets: 0,
            openingTreasuryAccounts: 0,
            openingStockMovements: 0,
          },
        });
      }
      if (url === "/api/imports/cutover-readiness") {
        return Promise.resolve({
          ready: false,
          status: "FAIL",
          checkedAt: "2026-01-01T00:00:00.000Z",
          checks: {
            reconciliation: {
              passed: false,
              totalControls: 8,
              passedControls: 7,
              failingKeys: ["ar"],
              summary: "1 of 8 control(s) out of balance: ar",
            },
            setupHealth: {
              passed: true,
              totalMappings: 28,
              validMappings: 28,
              issueCount: 0,
              summary: "All 28 required GL mappings healthy",
            },
            auditChain: {
              passed: false,
              totalChainedRows: 10,
              firstBrokenId: "audit-row-4",
              summary: "Audit hash chain broken at audit-row-4",
            },
          },
          reconciliation: { asOfDate: "2026-01-01", allReconciled: false, items: [] },
          setupHealth: { healthy: true, totalMappings: 28, validMappings: 28, issues: [] },
        });
      }
      return Promise.resolve({});
    });

    renderWithShell(<DataImports />);
    await waitFor(() => {
      expect(screen.getByTestId("cutover-readiness-badge")).toHaveTextContent(/FAIL/i);
      expect(screen.getByText(/1 of 8 control\(s\) out of balance: ar/i)).toBeInTheDocument();
      expect(screen.getByText(/Audit hash chain broken at audit-row-4/i)).toBeInTheDocument();
    });
  });

  it("2. excludes source=opening_balance from SalesVsPurchases while including it in ARAging", async () => {
    const admin = buildAdmin();
    apiRequestMock.mockImplementation((url: string) => {
      if (url === "/api/auth/me") return Promise.resolve({ user: admin });
      if (url === "/api/branches") return Promise.resolve({ branches: [{ id: "b1", code: "HQ", name: "Main HQ", isDefault: true }] });
      if (url === "/api/settings/company") return Promise.resolve({ settings: { currency: "EGP" } });
      if (url === "/api/settings/preferences") return Promise.resolve({ preferences: {} });
      if (url === "/api/customers") {
        return Promise.resolve({
          customers: [{ id: "c1", name: "Delta Customer", code: "CUST-1", currency: "EGP", paymentTermsDays: 30, createdAt: "2026-01-01", updatedAt: "2026-01-01" }],
        });
      }
      if (url === "/api/sales-invoices") {
        return Promise.resolve({
          invoices: [
            {
              id: "inv-open",
              invoiceNumber: "OPEN-AR-1",
              customerId: "c1",
              branchId: "b1",
              soId: null,
              status: "Sent",
              source: "opening_balance",
              invoiceDate: "2025-12-20T00:00:00.000Z",
              dueDate: "2026-01-20T00:00:00.000Z",
              subtotal: 45000,
              taxTotal: 0,
              totalAmount: 45000,
              paidAmount: 0,
              creditAppliedAmount: 0,
              retainerAppliedAmount: 0,
              voidReason: null,
              notes: "",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              lines: [],
            },
          ],
        });
      }
      if (url === "/api/vendor-bills") {
        return Promise.resolve({
          bills: [
            {
              id: "bill-open",
              billNumber: "OPEN-AP-1",
              vendorId: "v1",
              branchId: "b1",
              poId: null,
              receiveId: null,
              status: "Open",
              source: "opening_balance",
              billDate: "2025-12-20T00:00:00.000Z",
              dueDate: "2026-01-20T00:00:00.000Z",
              subtotal: 30000,
              taxTotal: 0,
              totalAmount: 30000,
              paidAmount: 0,
              voidReason: null,
              notes: "",
              createdAt: "2026-01-01T00:00:00.000Z",
              lines: [],
            },
          ],
        });
      }
      if (url.startsWith("/api/accounting/reports/profit-loss")) {
        return Promise.resolve({
          revenueAccounts: [],
          expenseAccounts: [],
          totalRevenue: 0,
          cogsTotal: 0,
          grossProfit: 0,
          operatingExpenses: 0,
          netIncome: 0,
        });
      }
      return Promise.resolve({});
    });

    const { unmount } = renderWithShell(<SalesVsPurchases />);
    await waitFor(() => {
      expect(screen.getByText(/No invoices or bills yet/i)).toBeInTheDocument();
    });
    unmount();

    renderWithShell(<ARAging />);
    await waitFor(() => {
      expect(screen.getByText("Delta Customer")).toBeInTheDocument();
    });
  });
});
