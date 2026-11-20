import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { BranchProvider } from "./contexts/BranchContext";
import { InventoryProvider } from "./contexts/InventoryContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import { PurchasesProvider } from "./contexts/PurchasesContext";
import { TaxonomyProvider } from "./contexts/TaxonomyContext";
import { AuditLogProvider } from "./contexts/AuditLogContext";
import { NotificationsProvider } from "./contexts/NotificationsContext";
import { SalesProvider } from "./contexts/SalesContext";
import { PermissionsProvider } from "./contexts/PermissionsContext";
import { SessionsProvider } from "./contexts/SessionsContext";
import { ProtectedRoute } from "./components/ProtectedRoute";
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
const Roles = lazy(() => import("./pages/admin/Roles"));
const Notifications = lazy(() => import("./pages/admin/Notifications"));
const Help = lazy(() => import("./pages/admin/Help"));
const Transfers = lazy(() => import("./pages/inventory/Transfers"));
const TransferDetail = lazy(() => import("./pages/inventory/TransferDetail"));
const Adjustments = lazy(() => import("./pages/inventory/Adjustments"));
const WriteOffs = lazy(() => import("./pages/inventory/WriteOffs"));
const Categories = lazy(() => import("./pages/taxonomy/Categories"));
const Brands = lazy(() => import("./pages/taxonomy/Brands"));
const UnitsOfMeasure = lazy(() => import("./pages/taxonomy/UnitsOfMeasure"));
const ChartOfAccounts = lazy(() => import("./pages/accounting/ChartOfAccounts"));
const JournalEntries = lazy(() => import("./pages/accounting/JournalEntries"));
const FiscalPeriods = lazy(() => import("./pages/accounting/FiscalPeriods"));
const FinancialStatements = lazy(() => import("./pages/accounting/FinancialStatements"));

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

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthProvider>
        <BranchProvider>
        <AuditLogProvider>
        <SettingsProvider>
          <InventoryProvider>
            <TaxonomyProvider>
            <PurchasesProvider>
              <PermissionsProvider>
              <NotificationsProvider>
              <SessionsProvider>
              <SalesProvider>
              <TooltipProvider>
              <Toaster />
              <Sonner />
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/*" element={
                  <ProtectedRoute>
                    <AppLayout>
                      <Suspense fallback={<PageLoader />}>
                        <Routes>
                          <Route path="/" element={<Dashboard />} />
                          <Route path="/products" element={<Products />} />
                          <Route path="/branches" element={<Branches />} />
                          <Route path="/branches/:branchId" element={<BranchDetail />} />
                          <Route path="/sessions" element={<Sessions />} />
                          <Route path="/sessions/:sessionId" element={<SessionDetail />} />
                          <Route path="/users" element={<Users />} />
                          <Route path="/profile" element={<Profile />} />
                          <Route path="/purchases/vendors" element={<Vendors />} />
                          <Route path="/purchases/vendors/:vendorId" element={<VendorDetail />} />
                          <Route path="/purchases/orders" element={<PurchaseOrders />} />
                          <Route path="/purchases/orders/new" element={<PurchaseOrderForm />} />
                          <Route path="/purchases/orders/:orderId" element={<PurchaseOrderForm />} />
                          <Route path="/purchases/orders/:orderId/edit" element={<PurchaseOrderForm />} />
                          <Route path="/purchases/receives" element={<PurchaseReceives />} />
                          <Route path="/purchases/receives/new" element={<PurchaseReceiveForm />} />
                          <Route path="/purchases/receives/:receiveId" element={<PurchaseReceiveForm />} />
                          <Route path="/purchases/bills" element={<VendorBills />} />
                          <Route path="/purchases/returns" element={<PurchaseReturns />} />
                          <Route path="/purchases/payments" element={<PaymentsMade />} />
                          <Route path="/sales/customers" element={<Customers />} />
                          <Route path="/sales/customers/:customerId" element={<CustomerDetail />} />
                          <Route path="/sales/orders" element={<SalesOrders />} />
                          <Route path="/sales/orders/new" element={<SalesOrderForm />} />
                          <Route path="/sales/orders/:orderId" element={<SalesOrderForm />} />
                          <Route path="/sales/orders/:orderId/edit" element={<SalesOrderForm />} />
                          <Route path="/sales/invoices" element={<Invoices />} />
                          <Route path="/sales/retainer-invoices" element={<RetainerInvoices />} />
                          <Route path="/sales/payments" element={<ReceivedPayments />} />
                          <Route path="/sales/returns" element={<SalesReturns />} />
                          <Route path="/analytics" element={<Analytics />} />
                          <Route path="/reports/inventory-valuation" element={<InventoryValuation />} />
                          <Route path="/reports/stock-aging" element={<StockAging />} />
                          <Route path="/reports/movement-history" element={<MovementHistory />} />
                          <Route path="/reports/po-aging" element={<POAging />} />
                          <Route path="/reports/ar-aging" element={<ARAging />} />
                          <Route path="/reports/sales-vs-purchases" element={<SalesVsPurchases />} />
                          <Route path="/audit-log" element={<AuditLog />} />
                          <Route path="/roles" element={<Roles />} />
                          <Route path="/notifications" element={<Notifications />} />
                          <Route path="/help" element={<Help />} />
                          <Route path="/inventory/transfers" element={<Transfers />} />
                          <Route path="/inventory/transfers/:transferId" element={<TransferDetail />} />
                          <Route path="/inventory/adjustments" element={<Adjustments />} />
                          <Route path="/inventory/write-offs" element={<WriteOffs />} />
                          <Route path="/categories" element={<Categories />} />
                          <Route path="/brands" element={<Brands />} />
                          <Route path="/units-of-measure" element={<UnitsOfMeasure />} />
                          <Route path="/accounting/accounts" element={<ChartOfAccounts />} />
                          <Route path="/accounting/journal-entries" element={<JournalEntries />} />
                          <Route path="/accounting/periods" element={<FiscalPeriods />} />
                          <Route path="/accounting/statements" element={<FinancialStatements />} />
                          <Route path="/settings" element={<Settings />} />
                          <Route path="*" element={<NotFound />} />
                        </Routes>
                      </Suspense>
                    </AppLayout>
                  </ProtectedRoute>
                } />
              </Routes>
              </TooltipProvider>
              </SalesProvider>
              </SessionsProvider>
              </NotificationsProvider>
              </PermissionsProvider>
            </PurchasesProvider>
            </TaxonomyProvider>
          </InventoryProvider>
        </SettingsProvider>
        </AuditLogProvider>
        </BranchProvider>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
