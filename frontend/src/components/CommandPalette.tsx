import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Building2,
  ClipboardList,
  Factory,
  FileCheck,
  FileText,
  History,
  Landmark,
  LayoutDashboard,
  Loader2,
  Package,
  Receipt,
  Search,
  Settings,
  Shield,
  ShoppingCart,
  Store,
  Target,
  Truck,
  Users,
} from "lucide-react";
import type { GlobalSearchResultItemDto, PermissionModule, SearchEntityType } from "@erp/shared";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useGlobalSearchQuery } from "@/hooks/queries/useSearchQuery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}

interface QuickNavItem {
  id: string;
  labelKey: string;
  fallbackLabel: string;
  route: string;
  keywords: string;
  module?: PermissionModule;
  icon: typeof LayoutDashboard;
}

const QUICK_NAV_ITEMS: readonly QuickNavItem[] = [
  { id: "dashboard", labelKey: "nav.dashboard", fallbackLabel: "Dashboard", route: "/", keywords: "home overview", icon: LayoutDashboard },
  { id: "products", labelKey: "nav.products", fallbackLabel: "Products", route: "/products", keywords: "catalog sku items", module: "products", icon: Package },
  { id: "branches", labelKey: "nav.branches", fallbackLabel: "Branches", route: "/branches", keywords: "warehouses stores", module: "branches", icon: Building2 },
  { id: "sessions", labelKey: "nav.sessions", fallbackLabel: "Sessions", route: "/sessions", keywords: "stock take count", module: "sessions", icon: ClipboardList },
  { id: "transfers", labelKey: "nav.inventoryOps.transfers", fallbackLabel: "Stock Transfers", route: "/inventory/transfers", keywords: "transfer dispatch", module: "inventory", icon: Truck },
  { id: "pos", labelKey: "nav.pos", fallbackLabel: "POS Register", route: "/pos", keywords: "cashier register sale", module: "pos", icon: Store },
  { id: "customers", labelKey: "nav.sales.customers", fallbackLabel: "All Customers", route: "/sales/customers", keywords: "clients buyers", module: "sales", icon: Users },
  { id: "sales-orders", labelKey: "nav.sales.salesOrders", fallbackLabel: "All Sales Orders", route: "/sales/orders", keywords: "so orders", module: "sales", icon: ShoppingCart },
  { id: "invoices", labelKey: "nav.sales.invoices", fallbackLabel: "Invoices", route: "/sales/invoices", keywords: "sales invoice billing", module: "sales", icon: FileText },
  { id: "vendors", labelKey: "nav.purchases.vendors", fallbackLabel: "Vendors", route: "/purchases/vendors", keywords: "suppliers", module: "purchases", icon: Users },
  { id: "purchase-orders", labelKey: "nav.purchases.purchaseOrders", fallbackLabel: "Purchase Orders", route: "/purchases/orders", keywords: "po procurement", module: "purchases", icon: ShoppingCart },
  { id: "bills", labelKey: "nav.purchases.bills", fallbackLabel: "Bills", route: "/purchases/bills", keywords: "vendor bills ap", module: "purchases", icon: Receipt },
  { id: "boms", labelKey: "nav.manufacturing.boms", fallbackLabel: "Bills of Materials", route: "/manufacturing/boms", keywords: "bom manufacturing", module: "manufacturing", icon: Factory },
  { id: "accounts", labelKey: "nav.accounting.accounts", fallbackLabel: "Chart of Accounts", route: "/accounting/accounts", keywords: "coa gl", module: "accounting", icon: BookOpen },
  { id: "cost-centers", labelKey: "nav.accounting.costCenters", fallbackLabel: "Cost Centers", route: "/accounting/cost-centers", keywords: "cost center department dimension", module: "accounting", icon: Target },
  { id: "journals", labelKey: "nav.accounting.journalEntries", fallbackLabel: "Journal Entries", route: "/accounting/journal-entries", keywords: "je ledger", module: "accounting", icon: BookOpen },
  { id: "treasury", labelKey: "nav.treasury.accounts", fallbackLabel: "Treasury & Bank", route: "/treasury/accounts", keywords: "bank cashbox transfer reconciliation statement", module: "treasury", icon: Landmark },
  { id: "expenses", labelKey: "nav.expenses", fallbackLabel: "Operating Expenses", route: "/expenses", keywords: "petty cash reimbursement expense claim", module: "expenses", icon: Receipt },
  { id: "approvals", labelKey: "nav.admin.approvals", fallbackLabel: "Approvals", route: "/approvals", keywords: "workflow approve", module: "approvals", icon: FileCheck },
  { id: "einvoicing", labelKey: "nav.admin.einvoicing", fallbackLabel: "E-Invoice Queue", route: "/admin/einvoicing", keywords: "eta zatca", module: "einvoicing", icon: FileText },
  { id: "audit-log", labelKey: "nav.admin.auditLog", fallbackLabel: "Audit Log", route: "/audit-log", keywords: "history diff", module: "audit", icon: History },
  { id: "roles", labelKey: "nav.admin.roles", fallbackLabel: "Roles & Permissions", route: "/roles", keywords: "rbac permissions", module: "roles", icon: Shield },
  { id: "users", labelKey: "nav.users", fallbackLabel: "Users", route: "/users", keywords: "staff accounts", module: "users", icon: Users },
  { id: "settings", labelKey: "nav.settings", fallbackLabel: "Settings", route: "/settings", keywords: "company mfa security", module: "settings", icon: Settings },
];

const ENTITY_ICON: Record<SearchEntityType, typeof Package> = {
  product: Package,
  customer: Users,
  vendor: Users,
  sales_order: ShoppingCart,
  sales_invoice: FileText,
  purchase_order: ShoppingCart,
  vendor_bill: Receipt,
  journal_entry: BookOpen,
};

export function CommandPalette({ open: controlledOpen, onOpenChange, showTrigger = true }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = usePermissions();

  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const setOpenState = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      onOpenChange?.(next);
      if (!next) {
        setQuery("");
        setDebouncedQuery("");
      }
    },
    [isControlled, onOpenChange]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenState(!isOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setOpenState]);

  useEffect(() => {
    if (!isOpen) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, isOpen]);

  const searchQuery = useGlobalSearchQuery(debouncedQuery, 20, isOpen);

  const permittedNavItems = useMemo(
    () =>
      QUICK_NAV_ITEMS.filter((item) => (!item.module ? true : can(item.module, "view"))).map((item) => ({
        ...item,
        label: t(item.labelKey, item.fallbackLabel),
      })),
    [can, t]
  );

  const filteredNavItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return permittedNavItems;
    return permittedNavItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q) ||
        item.route.toLowerCase().includes(q)
    );
  }, [permittedNavItems, query]);

  const groupedResults = useMemo(() => {
    const groups = new Map<SearchEntityType, GlobalSearchResultItemDto[]>();
    for (const item of searchQuery.data?.results ?? []) {
      const list = groups.get(item.type) ?? [];
      list.push(item);
      groups.set(item.type, list);
    }
    return Array.from(groups.entries());
  }, [searchQuery.data]);

  const handleSelectRoute = (route: string) => {
    setOpenState(false);
    navigate(route);
  };

  const isApplePlatform =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  const shortcutLabel = isApplePlatform ? "⌘K" : "Ctrl+K";

  return (
    <>
      {showTrigger && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpenState(true)}
            aria-label={t("commandPalette.triggerAria", "Open command palette")}
            data-testid="command-palette-trigger"
            className="hidden md:inline-flex items-center gap-2 text-muted-foreground h-9 px-3"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="text-xs">{t("commandPalette.triggerLabel", "Search or jump to...")}</span>
            <kbd className="ms-2 rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono">
              {shortcutLabel}
            </kbd>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setOpenState(true)}
            aria-label={t("commandPalette.triggerAria", "Open command palette")}
            className="md:hidden"
          >
            <Search className="h-4 w-4" />
          </Button>
        </>
      )}

      <Dialog open={isOpen} onOpenChange={setOpenState}>
        <DialogContent className="overflow-hidden p-0 shadow-lg max-w-xl">
          <DialogTitle className="sr-only">
            {t("commandPalette.title", "Command Palette")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("commandPalette.description", "Search records and navigate across the ERP workspace.")}
          </DialogDescription>
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4"
          >
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t("commandPalette.placeholder", "Search products, customers, invoices, or pages...")}
              aria-label={t("commandPalette.placeholder", "Search products, customers, invoices, or pages...")}
            />
            <CommandList>
              {searchQuery.isFetching && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("commandPalette.searching", "Searching...")}</span>
                </div>
              )}

              {groupedResults.length === 0 && filteredNavItems.length === 0 && !searchQuery.isFetching && (
                <CommandEmpty>
                  {t("commandPalette.noResults", "No matching records or pages found.")}
                </CommandEmpty>
              )}

              {groupedResults.map(([type, items]) => {
                const Icon = ENTITY_ICON[type] ?? FileText;
                const groupLabel = t(`commandPalette.groups.${type}`, type.replace(/_/g, " "));
                return (
                  <CommandGroup key={type} heading={groupLabel}>
                    {items.map((item) => (
                      <CommandItem
                        key={`${item.type}-${item.id}`}
                        value={`${item.type}:${item.id}:${item.title}`}
                        onSelect={() => handleSelectRoute(item.route)}
                        className="flex items-center justify-between gap-2 text-start"
                      >
                        <div className="flex items-center min-w-0">
                          <Icon className="me-2 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{item.title}</div>
                            {item.subtitle && (
                              <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                            )}
                          </div>
                        </div>
                        <Badge variant="outline" className="ms-auto shrink-0 text-[10px]">
                          {groupLabel}
                        </Badge>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}

              {groupedResults.length > 0 && filteredNavItems.length > 0 && <CommandSeparator />}

              {filteredNavItems.length > 0 && (
                <CommandGroup heading={t("commandPalette.quickNavigation", "Quick Navigation")}>
                  {filteredNavItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <CommandItem
                        key={item.id}
                        value={`nav:${item.id}:${item.label}`}
                        onSelect={() => handleSelectRoute(item.route)}
                        className="text-start"
                      >
                        <Icon className="me-2 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.label}</span>
                        <span className="ms-auto text-xs text-muted-foreground">{item.route}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
