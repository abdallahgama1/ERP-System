import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Package,
  Building2,
  ClipboardList,
  AlertTriangle,
  Plus,
  TrendingUp,
  DollarSign,
  Wallet,
} from "lucide-react";
import { useInventory } from "@/contexts/InventoryContext";
import { useSessions } from "@/contexts/SessionsContext";
import { useAuditLog } from "@/contexts/AuditLogContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useSales } from "@/contexts/SalesContext";
import { usePurchases } from "@/contexts/PurchasesContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useProfitLossQuery } from "@/hooks/queries/useAccountingQueries";
import { formatMoney } from "@/lib/money";
import { Link } from "react-router-dom";

const Dashboard = () => {
  const { t } = useTranslation();
  const { products, branches, branchProducts } = useInventory();
  const { sessions } = useSessions();
  const { entries: auditEntries } = useAuditLog();
  const { settings } = useSettings();
  const { can } = usePermissions();
  const { invoices } = useSales();
  const { bills } = usePurchases();
  const { data: pnl } = useProfitLossQuery({}, can("accounting", "view"));

  const finance = useMemo(() => {
    const open = invoices.filter((i) => i.status !== "Draft" && i.status !== "Cancelled");
    const revenue = open.reduce((s, i) => s + i.subtotal, 0);
    const purchases = bills
      .filter((b) => b.status !== "Draft" && b.status !== "Cancelled")
      .reduce((s, b) => s + b.subtotal, 0);
    const receivables = open.reduce((s, i) => s + Math.max(0, i.grandTotal - i.amountPaid), 0);
    const hasGlData = Boolean(pnl && (pnl.totalRevenue > 0 || pnl.cogsTotal > 0 || pnl.grossProfit !== 0));
    const grossMargin = hasGlData && pnl ? pnl.grossProfit : revenue - purchases;
    return {
      revenue: hasGlData && pnl ? pnl.totalRevenue : revenue,
      purchases,
      grossMargin,
      cogsTotal: pnl?.cogsTotal ?? 0,
      hasGlData,
      receivables,
    };
  }, [invoices, bills, pnl]);

  const stats = useMemo(() => {
    const lowProducts = products.filter((p) => p.quantity <= settings.lowStockThreshold).length;
    const lowBranchAllocations = branchProducts.filter(
      (bp) => bp.quantity <= settings.lowStockThreshold,
    ).length;
    return {
      totalProducts: products.length,
      totalBranches: branches.length,
      activeSessions: sessions.filter((s) => s.status === "Active" || s.status === "In Progress").length,
      lowStockAlerts: lowProducts + lowBranchAllocations,
    };
  }, [products, branches, branchProducts, sessions, settings.lowStockThreshold]);

  const recentActivity = useMemo(() => auditEntries.slice(0, 8), [auditEntries]);

  const statsCards = [
    {
      titleKey: "dashboard.totalProducts",
      value: stats.totalProducts,
      descriptionKey: "dashboard.productsInCatalog",
      icon: Package,
      color: "text-blue-600",
    },
    {
      titleKey: "dashboard.totalBranches",
      value: stats.totalBranches,
      descriptionKey: "dashboard.activeLocations",
      icon: Building2,
      color: "text-green-600",
    },
    {
      titleKey: "dashboard.activeSessions",
      value: stats.activeSessions,
      descriptionKey: "dashboard.ongoingInventoryCounts",
      icon: ClipboardList,
      color: "text-purple-600",
    },
    {
      titleKey: "dashboard.lowStockAlerts",
      value: stats.lowStockAlerts,
      descriptionKey: "dashboard.itemsNeedingAttention",
      icon: AlertTriangle,
      color: "text-orange-600",
    },
  ];

  const quickActions = [
    {
      titleKey: "dashboard.startNewSession",
      descriptionKey: "dashboard.beginNewSession",
      to: "/sessions",
      icon: Plus,
    },
    {
      titleKey: "dashboard.addNewProduct",
      descriptionKey: "dashboard.addProductToCatalog",
      to: "/products",
      icon: Package,
    },
    {
      titleKey: "dashboard.createBranch",
      descriptionKey: "dashboard.registerNewBranch",
      to: "/branches",
      icon: Building2,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground">{t("dashboard.subtitle")}</p>
        </div>
      </div>

      {/* Finance strip */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[
          {
            labelKey: "dashboard.revenue",
            defaultLabel: "Invoiced Revenue",
            value: finance.revenue,
            icon: DollarSign,
            color: "text-green-600",
          },
          {
            labelKey: "dashboard.purchasesTotal",
            defaultLabel: "Purchases",
            value: finance.purchases,
            icon: Wallet,
            color: "text-blue-600",
          },
          {
            labelKey: finance.hasGlData ? "dashboard.grossMargin" : "dashboard.cashFlowProxy",
            defaultLabel: finance.hasGlData ? "Gross Margin (COGS)" : "Net Sales vs. Bills (Cash-Flow Proxy)",
            hintText: finance.hasGlData
              ? `COGS: ${formatMoney(finance.cogsTotal, settings.currency)}`
              : undefined,
            value: finance.grossMargin,
            icon: TrendingUp,
            color: "text-purple-600",
          },
          {
            labelKey: "dashboard.receivables",
            defaultLabel: "Receivables",
            value: finance.receivables,
            icon: AlertTriangle,
            color: "text-orange-600",
          },
        ].map((item) => (
          <Card key={item.labelKey}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t(item.labelKey, item.defaultLabel)}</CardTitle>
              <item.icon className={`h-4 w-4 ${item.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatMoney(item.value, settings.currency)}
              </div>
              {item.hintText && (
                <p className="text-[11px] text-muted-foreground mt-1">{item.hintText}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statsCards.map((stat) => (
          <Card key={stat.titleKey}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{t(stat.titleKey)}</CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground">{t(stat.descriptionKey)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {quickActions.map((action) => (
          <Card key={action.titleKey} className="hover:shadow-md transition-shadow">
            <CardHeader>
              <div className="flex items-center gap-2">
                <action.icon className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">{t(action.titleKey)}</CardTitle>
              </div>
              <CardDescription>{t(action.descriptionKey)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full">
                <Link to={action.to}>{t("common.getStarted")}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Activity (Live from AuditLogContext) */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              <CardTitle>{t("dashboard.recentActivity")}</CardTitle>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/audit-log">{t("nav.admin.auditLog")}</Link>
            </Button>
          </div>
          <CardDescription>{t("dashboard.latestOperations")}</CardDescription>
        </CardHeader>
        <CardContent>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("dashboard.noRecentActivity", "No recent activity yet. Operations you perform will appear here.")}
            </p>
          ) : (
            <div className="space-y-4">
              {recentActivity.map((entry, idx) => (
                <div
                  key={entry.id}
                  className={`flex items-center justify-between ${
                    idx < recentActivity.length - 1 ? "border-b pb-2" : ""
                  }`}
                >
                  <div>
                    <p className="font-medium text-sm">{entry.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.user ? `${entry.user} · ` : ""}
                      {formatDistanceToNow(new Date(entry.at), { addSuffix: true })}
                    </p>
                  </div>
                  <Badge variant="outline">{entry.module}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Dashboard;
