import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
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
  RefreshCw,
} from "lucide-react";
import { useBranch } from "@/contexts/BranchContext";
import { useSettings } from "@/contexts/SettingsContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useProfitLossQuery } from "@/hooks/queries/useAccountingQueries";
import { useProductsQuery, type ApiBranchProductRow, type ApiProductRow } from "@/hooks/queries/useInventoryQueries";
import { useSessionsQuery, type ApiSession } from "@/hooks/queries/useSessionsQueries";
import { useSalesInvoicesQuery, type ApiInvoice } from "@/hooks/queries/useSalesQueries";
import { useVendorBillsQuery, type ApiBill } from "@/hooks/queries/usePurchasingQueries";
import { useRecentAuditLogsQuery, type AuditLogPageResponse } from "@/hooks/queries/useAuditLogsCursorQuery";
import { erpQueryKeys } from "@/hooks/queries/queryKeys";
import { formatMoney } from "@/lib/money";
import { Link } from "react-router-dom";

const Dashboard = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { branches } = useBranch();
  const { settings } = useSettings();
  const { can } = usePermissions();

  // Keep initial mount API footprint <= 5 GETs; load live domain metrics on explicit user action
  // while still rendering any already-cached TanStack Query data seamlessly.
  const [liveMetricsEnabled, setLiveMetricsEnabled] = useState(false);

  const productsQuery = useProductsQuery(liveMetricsEnabled && can("products", "view"));
  const sessionsQuery = useSessionsQuery(liveMetricsEnabled && can("sessions", "view"));
  const invoicesQuery = useSalesInvoicesQuery(liveMetricsEnabled && can("sales", "view"));
  const billsQuery = useVendorBillsQuery(liveMetricsEnabled && can("purchases", "view"));
  const pnlQuery = useProfitLossQuery({}, liveMetricsEnabled && can("accounting", "view"));
  const auditQuery = useRecentAuditLogsQuery(8, liveMetricsEnabled);

  const cachedProducts =
    productsQuery.data ??
    queryClient.getQueryData<{ products: ApiProductRow[]; branchProducts: ApiBranchProductRow[] }>(
      erpQueryKeys.inventory.products()
    );
  const cachedSessions =
    sessionsQuery.data ?? queryClient.getQueryData<{ sessions: ApiSession[] }>(erpQueryKeys.sessions.list());
  const cachedInvoices =
    invoicesQuery.data ?? queryClient.getQueryData<{ invoices: ApiInvoice[] }>(erpQueryKeys.sales.invoices());
  const cachedBills =
    billsQuery.data ?? queryClient.getQueryData<{ bills: ApiBill[] }>(erpQueryKeys.purchases.bills());
  const cachedAudit =
    auditQuery.data ??
    queryClient.getQueryData<AuditLogPageResponse>([...erpQueryKeys.auditLogs, "recent", 8]);

  const pnl = pnlQuery.data;

  const finance = useMemo(() => {
    const invoices = cachedInvoices?.invoices ?? [];
    const bills = cachedBills?.bills ?? [];
    const open = invoices.filter((i) => i.status !== "Draft" && i.status !== "Cancelled");
    const revenue = open
      .filter((i) => i.source !== "opening_balance")
      .reduce((s, i) => s + i.subtotal, 0);
    const purchases = bills
      .filter((b) => b.status !== "Draft" && b.status !== "Cancelled" && b.source !== "opening_balance")
      .reduce((s, b) => s + b.subtotal, 0);
    const receivables = open.reduce(
      (s, i) => s + Math.max(0, i.totalAmount - (i.paidAmount + i.creditAppliedAmount + i.retainerAppliedAmount)),
      0
    );
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
  }, [cachedInvoices, cachedBills, pnl]);

  const stats = useMemo(() => {
    const products = cachedProducts?.products ?? [];
    const branchProducts = cachedProducts?.branchProducts ?? [];
    const sessions = cachedSessions?.sessions ?? [];
    const lowProducts = products.filter((p) => p.totalQuantity <= settings.lowStockThreshold).length;
    const lowBranchAllocations = branchProducts.filter(
      (bp) => bp.quantity <= settings.lowStockThreshold
    ).length;
    return {
      totalProducts: products.length,
      totalBranches: branches.length,
      activeSessions: sessions.filter((s) => s.status === "In Progress").length,
      lowStockAlerts: lowProducts + lowBranchAllocations,
    };
  }, [cachedProducts, cachedSessions, branches.length, settings.lowStockThreshold]);

  const recentActivity = useMemo(() => (cachedAudit?.entries ?? []).slice(0, 8), [cachedAudit]);

  const isRefreshingMetrics =
    productsQuery.isFetching ||
    sessionsQuery.isFetching ||
    invoicesQuery.isFetching ||
    billsQuery.isFetching ||
    pnlQuery.isFetching ||
    auditQuery.isFetching;

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
      visible: can("sessions", "view"),
    },
    {
      titleKey: "dashboard.addNewProduct",
      descriptionKey: "dashboard.addProductToCatalog",
      to: "/products",
      icon: Package,
      visible: can("products", "view"),
    },
    {
      titleKey: "dashboard.createBranch",
      descriptionKey: "dashboard.registerNewBranch",
      to: "/branches",
      icon: Building2,
      visible: can("branches", "view"),
    },
  ].filter((a) => a.visible);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground">{t("dashboard.subtitle")}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (!liveMetricsEnabled) {
              setLiveMetricsEnabled(true);
            } else {
              void Promise.all([
                productsQuery.refetch(),
                sessionsQuery.refetch(),
                invoicesQuery.refetch(),
                billsQuery.refetch(),
                pnlQuery.refetch(),
                auditQuery.refetch(),
              ]);
            }
          }}
          disabled={isRefreshingMetrics}
        >
          <RefreshCw className={`h-4 w-4 me-2 ${isRefreshingMetrics ? "animate-spin" : ""}`} />
          {liveMetricsEnabled
            ? t("dashboard.refreshMetrics", "Refresh Metrics")
            : t("dashboard.loadLiveMetrics", "Load Live Metrics")}
        </Button>
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
              <div className="text-2xl font-bold">{formatMoney(item.value, settings.currency)}</div>
              {item.hintText && <p className="text-[11px] text-muted-foreground mt-1">{item.hintText}</p>}
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
      {quickActions.length > 0 && (
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
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              <CardTitle>{t("dashboard.recentActivity")}</CardTitle>
            </div>
            {(can("audit", "view") || can("reports", "view")) && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/audit-log">{t("nav.admin.auditLog")}</Link>
              </Button>
            )}
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
