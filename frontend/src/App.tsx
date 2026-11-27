import { lazy, Suspense, type ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import type { PermissionAction, PermissionModule } from "@erp/shared";
import { AuthProvider } from "./contexts/AuthContext";
import { BranchProvider } from "./contexts/BranchContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { PermissionsProvider } from "./contexts/PermissionsContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { RequirePermission } from "./components/auth/RequirePermission";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppLayout } from "./components/layout/AppLayout";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Products = lazy(() => import("./pages/Products"));
const Branches = lazy(() => import("./pages/Branches"));
const BranchDetail = lazy(() => import("./pages/BranchDetail"));
const Sessions = lazy(() => import("./pages/Sessions"));
const SessionDetail = lazy(() => import("./pages/SessionDetail"));
const Users = lazy(() => import("./pages/Users"));
const Profile = lazy(() => import("./pages/Profile"));
const Settings = lazy(() => import("./pages/Settings"));
const Vendors = lazy(() => import("./pages/purchases/Vendors"));
const PurchaseOrders = lazy(() => import("./pages/purchases/PurchaseOrders"));
const PurchaseOrderForm = lazy(() => import("./pages/purchases/PurchaseOrderForm"));
const PurchaseReceives = lazy(() => import("./pages/purchases/PurchaseReceives"));
const PurchaseReceiveForm = lazy(() => import("./pages/purchases/PurchaseReceiveForm"));
const VendorDetail = lazy(() => import("./pages/purchases/VendorDetail"));
const VendorBills = lazy(() => import("./pages/purchases/VendorBills"));
const PurchaseReturns = lazy(() => import("./pages/purchases/PurchaseReturns"));
const PaymentsMade = lazy(() => import("./pages/purchases/PaymentsMade"));
const Customers = lazy(() => import("./pages/sales/Customers"));
const CustomerDetail = lazy(() => import("./pages/sales/CustomerDetail"));
const SalesOrders = lazy(() => import("./pages/sales/SalesOrders"));
const SalesOrderForm = lazy(() => import("./pages/sales/SalesOrderForm"));
const Invoices = lazy(() => import("./pages/sales/Invoices"));
const RetainerInvoices = lazy(() => import("./pages/sales/RetainerInvoices"));
const ReceivedPayments = lazy(() => import("./pages/sales/ReceivedPayments"));
const SalesReturns = lazy(() => import("./pages/sales/SalesReturns"));
const Analytics = lazy(() => import("./pages/reports/Analytics"));
const InventoryValuation = lazy(() => import("./pages/reports/InventoryValuation"));
const StockAging = lazy(() => import("./pages/reports/StockAging"));
const MovementHistory = lazy(() => import("./pages/reports/MovementHistory"));
const POAging = lazy(() => import("./pages/reports/POAging"));
const SalesVsPurchases = lazy(() => import("./pages/reports/SalesVsPurchases"));
const ARAging = lazy(() => import("./pages/reports/ARAging"));
const AuditLog = lazy(() => import("./pages/admin/AuditLog"));
const Approvals = lazy(() => import("./pages/admin/Approvals"));
const EInvoiceQueue = lazy(() => import("./pages/admin/EInvoiceQueue"));
const DataImports = lazy(() => import("./pages/admin/DataImports"));
const Roles = lazy(() => import("./pages/admin/Roles"));
const Notifications = lazy(() => import("./pages/admin/Notifications"));
const Help = lazy(() => import("./pages/admin/Help"));
const Transfers = lazy(() => import("./pages/inventory/Transfers"));
const TransferDetail = lazy(() => import("./pages/inventory/TransferDetail"));
const Adjustments = lazy(() => import("./pages/inventory/Adjustments"));
const WriteOffs = lazy(() => import("./pages/inventory/WriteOffs"));
const LotsAndExpiry = lazy(() => import("./pages/inventory/LotsAndExpiry"));
const SerialNumbers = lazy(() => import("./pages/inventory/SerialNumbers"));
const BillsOfMaterials = lazy(() => import("./pages/manufacturing/BillsOfMaterials"));
const WorkOrders = lazy(() => import("./pages/manufacturing/WorkOrders"));
const Categories = lazy(() => import("./pages/taxonomy/Categories"));
const Brands = lazy(() => import("./pages/taxonomy/Brands"));
const UnitsOfMeasure = lazy(() => import("./pages/taxonomy/UnitsOfMeasure"));
const ChartOfAccounts = lazy(() => import("./pages/accounting/ChartOfAccounts"));
const CostCenters = lazy(() => import("./pages/accounting/CostCenters"));
const JournalEntries = lazy(() => import("./pages/accounting/JournalEntries"));
const FiscalPeriods = lazy(() => import("./pages/accounting/FiscalPeriods"));
const FinancialStatements = lazy(() => import("./pages/accounting/FinancialStatements"));
const FixedAssets = lazy(() => import("./pages/accounting/FixedAssets"));
const AccountingSetupHealth = lazy(() => import("./pages/accounting/AccountingSetupHealth"));
const AccountingReconciliation = lazy(() => import("./pages/accounting/AccountingReconciliation"));
const TreasuryAccounts = lazy(() => import("./pages/treasury/TreasuryAccounts"));
const Expenses = lazy(() => import("./pages/expenses/Expenses"));
const PosRegister = lazy(() => import("./pages/pos/PosRegister"));

const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[40vh]">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const guard = (module: PermissionModule, element: ReactNode, action: PermissionAction = "view") => (
  <RequirePermission module={module} action={action} mode="page">
    {element}
  </RequirePermission>
);

const BackOfficeWorkspace = () => (
  <AppLayout>
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/products" element={guard("products", <Products />)} />
        <Route path="/branches" element={guard("branches", <Branches />)} />
        <Route path="/branches/:branchId" element={guard("branches", <BranchDetail />)} />
        <Route path="/sessions" element={guard("sessions", <Sessions />)} />
        <Route path="/sessions/:sessionId" element={guard("sessions", <SessionDetail />)} />
        <Route path="/users" element={guard("users", <Users />)} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/purchases/vendors" element={guard("purchases", <Vendors />)} />
        <Route path="/purchases/vendors/:vendorId" element={guard("purchases", <VendorDetail />)} />
        <Route path="/purchases/orders" element={guard("purchases", <PurchaseOrders />)} />
        <Route path="/purchases/orders/new" element={guard("purchases", <PurchaseOrderForm />, "create")} />
        <Route path="/purchases/orders/:orderId" element={guard("purchases", <PurchaseOrderForm />)} />
        <Route path="/purchases/orders/:orderId/edit" element={guard("purchases", <PurchaseOrderForm />, "edit")} />
        <Route path="/purchases/receives" element={guard("purchases", <PurchaseReceives />)} />
        <Route path="/purchases/receives/new" element={guard("purchases", <PurchaseReceiveForm />, "create")} />
        <Route path="/purchases/receives/:receiveId" element={guard("purchases", <PurchaseReceiveForm />)} />
        <Route path="/purchases/bills" element={guard("purchases", <VendorBills />)} />
        <Route path="/purchases/returns" element={guard("purchases", <PurchaseReturns />)} />
        <Route path="/purchases/payments" element={guard("purchases", <PaymentsMade />)} />
        <Route path="/sales/customers" element={guard("sales", <Customers />)} />
        <Route path="/sales/customers/:customerId" element={guard("sales", <CustomerDetail />)} />
        <Route path="/sales/orders" element={guard("sales", <SalesOrders />)} />
        <Route path="/sales/orders/new" element={guard("sales", <SalesOrderForm />, "create")} />
        <Route path="/sales/orders/:orderId" element={guard("sales", <SalesOrderForm />)} />
        <Route path="/sales/orders/:orderId/edit" element={guard("sales", <SalesOrderForm />, "edit")} />
        <Route path="/sales/invoices" element={guard("sales", <Invoices />)} />
        <Route path="/sales/retainer-invoices" element={guard("sales", <RetainerInvoices />)} />
        <Route path="/sales/payments" element={guard("sales", <ReceivedPayments />)} />
        <Route path="/sales/returns" element={guard("sales", <SalesReturns />)} />
        <Route path="/analytics" element={guard("reports", <Analytics />)} />
        <Route path="/reports/inventory-valuation" element={guard("reports", <InventoryValuation />)} />
        <Route path="/reports/stock-aging" element={guard("reports", <StockAging />)} />
        <Route path="/reports/movement-history" element={guard("reports", <MovementHistory />)} />
        <Route path="/reports/po-aging" element={guard("reports", <POAging />)} />
        <Route path="/reports/ar-aging" element={guard("reports", <ARAging />)} />
        <Route path="/reports/sales-vs-purchases" element={guard("reports", <SalesVsPurchases />)} />
        <Route path="/audit-log" element={guard("audit", <AuditLog />)} />
        <Route path="/approvals" element={guard("approvals", <Approvals />)} />
        <Route path="/admin/einvoicing" element={guard("einvoicing", <EInvoiceQueue />)} />
        <Route path="/einvoicing" element={guard("einvoicing", <EInvoiceQueue />)} />
        <Route
          path="/admin/imports"
          element={
            <RequirePermission roles={["admin"]} mode="page">
              <DataImports />
            </RequirePermission>
          }
        />
        <Route path="/roles" element={guard("roles", <Roles />)} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/help" element={<Help />} />
        <Route path="/inventory/transfers" element={guard("inventory", <Transfers />)} />
        <Route path="/inventory/transfers/:transferId" element={guard("inventory", <TransferDetail />)} />
        <Route path="/inventory/adjustments" element={guard("inventory", <Adjustments />)} />
        <Route path="/inventory/write-offs" element={guard("inventory", <WriteOffs />)} />
        <Route path="/inventory/lots" element={guard("inventory", <LotsAndExpiry />)} />
        <Route path="/inventory/serials" element={guard("inventory", <SerialNumbers />)} />
        <Route path="/manufacturing/boms" element={guard("manufacturing", <BillsOfMaterials />)} />
        <Route path="/manufacturing/work-orders" element={guard("manufacturing", <WorkOrders />)} />
        <Route path="/categories" element={guard("taxonomy", <Categories />)} />
        <Route path="/brands" element={guard("taxonomy", <Brands />)} />
        <Route path="/units-of-measure" element={guard("taxonomy", <UnitsOfMeasure />)} />
        <Route path="/accounting/accounts" element={guard("accounting", <ChartOfAccounts />)} />
        <Route path="/accounting/cost-centers" element={guard("accounting", <CostCenters />)} />
        <Route path="/accounting/journal-entries" element={guard("accounting", <JournalEntries />)} />
        <Route path="/accounting/periods" element={guard("accounting", <FiscalPeriods />)} />
        <Route path="/accounting/statements" element={guard("accounting", <FinancialStatements />)} />
        <Route
          path="/accounting/setup-health"
          element={
            <RequirePermission module="accounting" action="view" roles={["admin"]} mode="page">
              <AccountingSetupHealth />
            </RequirePermission>
          }
        />
        <Route
          path="/accounting/reconciliation"
          element={
            <RequirePermission module="accounting" action="view" roles={["admin"]} mode="page">
              <AccountingReconciliation />
            </RequirePermission>
          }
        />
        <Route path="/accounting/fixed-assets" element={guard("fixed_assets", <FixedAssets />)} />
        <Route path="/treasury/accounts" element={guard("treasury", <TreasuryAccounts />)} />
        <Route path="/expenses" element={guard("expenses", <Expenses />)} />
        <Route path="/settings" element={guard("settings", <Settings />)} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  </AppLayout>
);

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <BranchProvider>
            <SettingsProvider>
              <PermissionsProvider>
                <TooltipProvider>
                  <Toaster />
                  <Sonner />
                  <Routes>
                    <Route path="/login" element={<Login />} />
                    <Route path="/signup" element={<Signup />} />
                    <Route path="/reset-password" element={<ResetPassword />} />
                    {/* Dedicated lightweight POS / Cashier Register PWA workspace */}
                    <Route
                      path="/pos/*"
                      element={
                        <ProtectedRoute>
                          <RequirePermission module="pos" action="view" mode="page">
                            <Suspense fallback={<PageLoader />}>
                              <Routes>
                                <Route path="/" element={<PosRegister />} />
                                <Route path="*" element={<PosRegister />} />
                              </Routes>
                            </Suspense>
                          </RequirePermission>
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/*"
                      element={
                        <ProtectedRoute>
                          <BackOfficeWorkspace />
                        </ProtectedRoute>
                      }
                    />
                  </Routes>
                </TooltipProvider>
              </PermissionsProvider>
            </SettingsProvider>
          </BranchProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
