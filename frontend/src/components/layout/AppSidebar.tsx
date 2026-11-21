import { useState } from "react";
import { useTranslation } from "react-i18next";
import { 
  LayoutDashboard, 
  Package, 
  Building2, 
  ClipboardList, 
  Users, 
  LogOut,
  ChevronDown,
  ShoppingCart,
  ShoppingBag,
  UserCheck,
  FileText,
  Receipt,
  CreditCard,
  RotateCcw,
  Truck,
  PackageCheck,
  Wallet,
  BarChart3,
  Clock,
  TrendingUp,
  ArrowLeftRight,
  ArrowRightLeft,
  Sliders,
  Trash2,
  FolderTree,
  Tag,
  Ruler,
  Shield,
  Bell,
  HelpCircle,
  History,
  BookOpen,
  Scale,
  CalendarClock,
  ClipboardCheck,
  Layers,
  Barcode,
  Boxes,
  Factory,
  MonitorSmartphone
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions, type PermissionModule } from "@/contexts/PermissionsContext";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

const mainItems: Array<{ titleKey: string; url: string; icon: typeof LayoutDashboard; module?: PermissionModule }> = [
  { titleKey: "nav.dashboard", url: "/", icon: LayoutDashboard },
  { titleKey: "nav.pos", url: "/pos", icon: MonitorSmartphone, module: "pos" },
  { titleKey: "nav.products", url: "/products", icon: Package, module: "products" },
  { titleKey: "nav.branches", url: "/branches", icon: Building2, module: "branches" },
  { titleKey: "nav.sessions", url: "/sessions", icon: ClipboardList, module: "sessions" },
];

const salesItems = [
  { titleKey: "nav.sales.customers", url: "/sales/customers", icon: UserCheck },
  { titleKey: "nav.sales.retainerInvoices", url: "/sales/retainer-invoices", icon: FileText },
  { titleKey: "nav.sales.salesOrders", url: "/sales/orders", icon: ShoppingCart },
  { titleKey: "nav.sales.invoices", url: "/sales/invoices", icon: Receipt },
  { titleKey: "nav.sales.receivedPayments", url: "/sales/payments", icon: CreditCard },
  { titleKey: "nav.sales.salesReturns", url: "/sales/returns", icon: RotateCcw },
];

const purchasesItems = [
  { titleKey: "nav.purchases.vendors", url: "/purchases/vendors", icon: Truck },
  { titleKey: "nav.purchases.purchaseOrders", url: "/purchases/orders", icon: ShoppingBag },
  { titleKey: "nav.purchases.purchaseReceives", url: "/purchases/receives", icon: PackageCheck },
  { titleKey: "nav.purchases.bills", url: "/purchases/bills", icon: Receipt },
  { titleKey: "nav.purchases.purchaseReturns", url: "/purchases/returns", icon: RotateCcw },
  { titleKey: "nav.purchases.paymentMade", url: "/purchases/payments", icon: Wallet },
];

const inventoryOpsItems = [
  { titleKey: "nav.inventoryOps.transfers", url: "/inventory/transfers", icon: ArrowRightLeft },
  { titleKey: "nav.inventoryOps.adjustments", url: "/inventory/adjustments", icon: Sliders },
  { titleKey: "nav.inventoryOps.writeOffs", url: "/inventory/write-offs", icon: Trash2 },
  { titleKey: "nav.inventoryOps.lots", url: "/inventory/lots", icon: Layers },
  { titleKey: "nav.inventoryOps.serials", url: "/inventory/serials", icon: Barcode },
];

const manufacturingItems = [
  { titleKey: "nav.manufacturing.boms", url: "/manufacturing/boms", icon: Boxes },
  { titleKey: "nav.manufacturing.workOrders", url: "/manufacturing/work-orders", icon: Factory },
];

const accountingItems = [
  { titleKey: "nav.accounting.accounts", url: "/accounting/accounts", icon: BookOpen },
  { titleKey: "nav.accounting.journalEntries", url: "/accounting/journal-entries", icon: FileText },
  { titleKey: "nav.accounting.fiscalPeriods", url: "/accounting/periods", icon: CalendarClock },
  { titleKey: "nav.accounting.financialStatements", url: "/accounting/statements", icon: Scale },
];

const reportsItems = [
  { titleKey: "nav.reports.analytics", url: "/analytics", icon: BarChart3 },
  { titleKey: "nav.reports.inventoryValuation", url: "/reports/inventory-valuation", icon: Package },
  { titleKey: "nav.reports.stockAging", url: "/reports/stock-aging", icon: Clock },
  { titleKey: "nav.reports.movementHistory", url: "/reports/movement-history", icon: ArrowLeftRight },
  { titleKey: "nav.reports.poAging", url: "/reports/po-aging", icon: Clock },
  { titleKey: "nav.reports.arAging", url: "/reports/ar-aging", icon: Clock },
  { titleKey: "nav.reports.salesVsPurchases", url: "/reports/sales-vs-purchases", icon: TrendingUp },
];

const taxonomyItems = [
  { titleKey: "nav.taxonomy.categories", url: "/categories", icon: FolderTree },
  { titleKey: "nav.taxonomy.brands", url: "/brands", icon: Tag },
  { titleKey: "nav.taxonomy.units", url: "/units-of-measure", icon: Ruler },
];

const adminItems = [
  { titleKey: "nav.admin.approvals", url: "/approvals", icon: ClipboardCheck },
  { titleKey: "nav.admin.einvoicing", url: "/admin/einvoicing", icon: Receipt },
  { titleKey: "nav.admin.auditLog", url: "/audit-log", icon: History },
  { titleKey: "nav.admin.roles", url: "/roles", icon: Shield },
  { titleKey: "nav.admin.notifications", url: "/notifications", icon: Bell },
  { titleKey: "nav.admin.help", url: "/help", icon: HelpCircle },
];

const bottomItems: Array<{ titleKey: string; url: string; icon: typeof Users; module?: PermissionModule }> = [
  { titleKey: "nav.users", url: "/users", icon: Users, module: "users" },
];

export function AppSidebar() {
  const { t } = useTranslation();
  const { state } = useSidebar();
  const { logout } = useAuth();
  const { can } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname;
  const collapsed = state === "collapsed";

  const [salesOpen, setSalesOpen] = useState(
    salesItems.some(item => currentPath.startsWith(item.url))
  );
  const [purchasesOpen, setPurchasesOpen] = useState(
    purchasesItems.some(item => currentPath.startsWith(item.url))
  );
  const [inventoryOpsOpen, setInventoryOpsOpen] = useState(
    inventoryOpsItems.some(item => currentPath.startsWith(item.url))
  );
  const [manufacturingOpen, setManufacturingOpen] = useState(
    manufacturingItems.some(item => currentPath.startsWith(item.url))
  );
  const [accountingOpen, setAccountingOpen] = useState(
    accountingItems.some(item => currentPath.startsWith(item.url))
  );
  const [reportsOpen, setReportsOpen] = useState(
    reportsItems.some(item => currentPath.startsWith(item.url))
  );
  const [taxonomyOpen, setTaxonomyOpen] = useState(
    taxonomyItems.some(item => currentPath.startsWith(item.url))
  );
  const [adminOpen, setAdminOpen] = useState(
    adminItems.some(item => currentPath.startsWith(item.url))
  );

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const isActive = (url: string) => {
    if (url === "/") return currentPath === "/";
    return currentPath.startsWith(url);
  };

  const isSalesActive = salesItems.some(item => currentPath.startsWith(item.url));
  const isPurchasesActive = purchasesItems.some(item => currentPath.startsWith(item.url));
  const isInventoryOpsActive = inventoryOpsItems.some(item => currentPath.startsWith(item.url));
  const isAccountingActive = accountingItems.some(item => currentPath.startsWith(item.url));
  const isReportsActive = reportsItems.some(item => currentPath.startsWith(item.url));
  const isTaxonomyActive = taxonomyItems.some(item => currentPath.startsWith(item.url));
  const isAdminActive = adminItems.some(item => currentPath.startsWith(item.url));

  const renderGroup = (
    items: typeof salesItems,
    titleKey: string,
    GroupIcon: typeof ShoppingCart,
    open: boolean,
    setOpen: (v: boolean) => void,
    active: boolean,
  ) => (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            className={`h-11 text-base transition-none w-full ${active ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
          >
            <GroupIcon className="h-5 w-5" />
            {!collapsed && (
              <>
                <span className="flex-1 text-start">{t(titleKey)}</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
              </>
            )}
          </SidebarMenuButton>
        </CollapsibleTrigger>
        {!collapsed && (
          <CollapsibleContent>
            <SidebarMenu className="ms-4 mt-1 space-y-1 border-s border-sidebar-border ps-2">
              {items.map((item) => {
                const a = isActive(item.url);
                return (
                  <SidebarMenuItem key={item.titleKey}>
                    <SidebarMenuButton
                      asChild
                      className={`h-9 text-sm transition-none ${a ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                    >
                      <Link to={item.url}>
                        <item.icon className="h-4 w-4" />
                        <span>{t(item.titleKey)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </CollapsibleContent>
        )}
      </SidebarMenuItem>
    </Collapsible>
  );

  return (
    <Sidebar
      className={collapsed ? "w-14" : "w-60"}
      collapsible="icon"
    >
      <SidebarContent className="flex flex-col h-full">
        <SidebarGroup className="flex-1">
          <SidebarGroupLabel className="text-sidebar-foreground font-semibold mb-6">
            {t('common.appName')}
          </SidebarGroupLabel>
          
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {/* Main navigation items */}
              {mainItems
                .filter((item) => !item.module || can(item.module, "view"))
                .map((item) => {
                const active = isActive(item.url);
                return (
                  <SidebarMenuItem key={item.titleKey}>
                    <SidebarMenuButton 
                      asChild 
                      className={`h-11 text-base transition-none ${active ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                    >
                      <Link to={item.url}>
                        <item.icon className="h-5 w-5" />
                        {!collapsed && <span>{t(item.titleKey)}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}

              {/* Sales Dropdown */}
              {can("sales", "view") && (
              <Collapsible open={salesOpen} onOpenChange={setSalesOpen}>
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton 
                      className={`h-11 text-base transition-none w-full ${isSalesActive ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                    >
                      <ShoppingCart className="h-5 w-5" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-start">{t('nav.sales.title')}</span>
                          <ChevronDown className={`h-4 w-4 transition-transform ${salesOpen ? "rotate-180" : ""}`} />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  {!collapsed && (
                    <CollapsibleContent>
                      <SidebarMenu className="ms-4 mt-1 space-y-1 border-s border-sidebar-border ps-2">
                        {salesItems.map((item) => {
                          const active = isActive(item.url);
                          return (
                            <SidebarMenuItem key={item.titleKey}>
                              <SidebarMenuButton 
                                asChild 
                                className={`h-9 text-sm transition-none ${active ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                              >
                                <Link to={item.url}>
                                  <item.icon className="h-4 w-4" />
                                  <span>{t(item.titleKey)}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </CollapsibleContent>
                  )}
                </SidebarMenuItem>
              </Collapsible>
              )}

              {/* Purchases Dropdown */}
              {can("purchases", "view") && (
              <Collapsible open={purchasesOpen} onOpenChange={setPurchasesOpen}>
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton 
                      className={`h-11 text-base transition-none w-full ${isPurchasesActive ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                    >
                      <ShoppingBag className="h-5 w-5" />
                      {!collapsed && (
                        <>
                          <span className="flex-1 text-start">{t('nav.purchases.title')}</span>
                          <ChevronDown className={`h-4 w-4 transition-transform ${purchasesOpen ? "rotate-180" : ""}`} />
                        </>
                      )}
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  {!collapsed && (
                    <CollapsibleContent>
                      <SidebarMenu className="ms-4 mt-1 space-y-1 border-s border-sidebar-border ps-2">
                        {purchasesItems.map((item) => {
                          const active = isActive(item.url);
                          return (
                            <SidebarMenuItem key={item.titleKey}>
                              <SidebarMenuButton 
                                asChild 
                                className={`h-9 text-sm transition-none ${active ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                              >
                                <Link to={item.url}>
                                  <item.icon className="h-4 w-4" />
                                  <span>{t(item.titleKey)}</span>
                                </Link>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </CollapsibleContent>
                  )}
                </SidebarMenuItem>
              </Collapsible>
              )}

              {/* Bottom items (Users) */}
              {can("inventory", "view") && renderGroup(inventoryOpsItems, "nav.inventoryOps.title", ArrowRightLeft, inventoryOpsOpen, setInventoryOpsOpen, isInventoryOpsActive)}
              {can("inventory", "view") && renderGroup(manufacturingItems, "nav.manufacturing.title", Factory, manufacturingOpen, setManufacturingOpen, manufacturingItems.some(item => currentPath.startsWith(item.url)))}
              {can("accounting", "view") && renderGroup(accountingItems, "nav.accounting.title", Scale, accountingOpen, setAccountingOpen, isAccountingActive)}
              {can("reports", "view") && renderGroup(reportsItems, "nav.reports.title", BarChart3, reportsOpen, setReportsOpen, isReportsActive)}
              {can("taxonomy", "view") && renderGroup(taxonomyItems, "nav.taxonomy.title", FolderTree, taxonomyOpen, setTaxonomyOpen, isTaxonomyActive)}
              {renderGroup(adminItems, "nav.admin.title", Shield, adminOpen, setAdminOpen, isAdminActive)}

              {bottomItems
                .filter((item) => !item.module || can(item.module, "view"))
                .map((item) => {
                const active = isActive(item.url);
                return (
                  <SidebarMenuItem key={item.titleKey}>
                    <SidebarMenuButton 
                      asChild 
                      className={`h-11 text-base transition-none ${active ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "hover:bg-sidebar-accent/50"}`}
                    >
                      <Link to={item.url}>
                        <item.icon className="h-5 w-5" />
                        {!collapsed && <span>{t(item.titleKey)}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto pb-4">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton 
                  className="h-11 text-base text-destructive hover:bg-destructive/10 transition-none"
                  onClick={handleLogout}
                >
                  <LogOut className="h-5 w-5" />
                  {!collapsed && <span>{t('common.logout')}</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
