import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CalendarClock, Download, Layers, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useBranch } from "@/contexts/BranchContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useLotsQuery } from "@/hooks/queries/useTrackingQueries";
import { formatMoney } from "@/lib/money";

export default function LotsAndExpiry() {
  const { t } = useTranslation();
  const { activeBranchId } = useBranch();
  const { settings } = useSettings();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data, isLoading } = useLotsQuery(activeBranchId);
  const lots = useMemo(() => data?.lots ?? [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lots.filter((l) => {
      if (statusFilter !== "all" && l.expiryStatus !== statusFilter) return false;
      if (!q) return true;
      return (
        l.lotNumber.toLowerCase().includes(q) ||
        l.productName.toLowerCase().includes(q) ||
        l.productSku.toLowerCase().includes(q) ||
        l.branchName.toLowerCase().includes(q)
      );
    });
  }, [lots, search, statusFilter]);

  const summary = useMemo(() => {
    return lots.reduce(
      (acc, l) => {
        acc.total += 1;
        if (l.expiryStatus === "expired") acc.expired += 1;
        else if (l.expiryStatus === "expiring_soon") acc.expiringSoon += 1;
        return acc;
      },
      { total: 0, expired: 0, expiringSoon: 0 }
    );
  }, [lots]);

  const exportCsv = () => {
    const headers = ["Lot Number", "SKU", "Product", "Branch", "Qty On Hand", "Unit Cost", "Expiry Date", "Status"];
    const rows = filtered.map((l) => [
      l.lotNumber,
      l.productSku,
      l.productName,
      l.branchName,
      l.qtyOnHand,
      l.unitCost,
      l.expiryDate ? l.expiryDate.slice(0, 10) : "",
      l.expiryStatus,
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lots-expiry-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusBadge = (status: "valid" | "expiring_soon" | "expired" | "no_expiry") => {
    if (status === "expired") return <Badge variant="destructive">{t("tracking.lots.expired", "Expired")}</Badge>;
    if (status === "expiring_soon")
      return <Badge variant="secondary">{t("tracking.lots.expiringSoon", "Expiring Soon")}</Badge>;
    if (status === "valid") return <Badge variant="default">{t("tracking.lots.valid", "Valid")}</Badge>;
    return <Badge variant="outline">{t("tracking.lots.noExpiry", "No Expiry")}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-7 w-7 text-primary" />
            {t("tracking.lots.title", "Lots & Expiry Tracking")}
          </h1>
          <p className="text-muted-foreground">
            {t("tracking.lots.description", "Monitor FEFO/FIFO batch balances and upcoming expirations across branches.")}
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
          <Download className="h-4 w-4 me-2" />
          {t("common.export", "Export CSV")}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("tracking.lots.activeLots", "Active Lots On Hand")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{summary.total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <CalendarClock className="h-4 w-4 text-amber-500" />
              {t("tracking.lots.expiringSoon", "Expiring Soon (≤ 30d)")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold text-amber-600">{summary.expiringSoon}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t("tracking.lots.expired", "Expired Lots")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold text-destructive">{summary.expired}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("tracking.lots.balances", "Lot Balances")}</CardTitle>
          <CardDescription>
            {t("tracking.lots.balancesDesc", "Expired lots are automatically blocked from sales fulfillment and flagged for write-off.")}
          </CardDescription>
          <div className="flex flex-wrap gap-3 pt-2">
            <div className="relative flex-1 min-w-[220px] max-w-sm">
              <Search className="h-4 w-4 text-muted-foreground absolute start-3 top-3" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("tracking.lots.search", "Search lot #, SKU, or product...")}
                className="ps-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all", "All Statuses")}</SelectItem>
                <SelectItem value="valid">{t("tracking.lots.valid", "Valid")}</SelectItem>
                <SelectItem value="expiring_soon">{t("tracking.lots.expiringSoon", "Expiring Soon")}</SelectItem>
                <SelectItem value="expired">{t("tracking.lots.expired", "Expired")}</SelectItem>
                <SelectItem value="no_expiry">{t("tracking.lots.noExpiry", "No Expiry")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-muted-foreground">{t("common.loading", "Loading...")}</div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {t("tracking.lots.empty", "No active lot balances found.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("tracking.lots.lotNumber", "Lot #")}</TableHead>
                  <TableHead>{t("products.productName", "Product")}</TableHead>
                  <TableHead>{t("branches.branch", "Branch")}</TableHead>
                  <TableHead className="text-end">{t("common.quantity", "Qty")}</TableHead>
                  <TableHead className="text-end">{t("products.costPrice", "Unit Cost")}</TableHead>
                  <TableHead>{t("tracking.lots.expiryDate", "Expiry Date")}</TableHead>
                  <TableHead>{t("common.status", "Status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((lot) => (
                  <TableRow key={lot.id}>
                    <TableCell className="font-mono font-medium">{lot.lotNumber}</TableCell>
                    <TableCell>
                      <div className="font-medium">{lot.productName}</div>
                      <div className="text-xs text-muted-foreground">{lot.productSku}</div>
                    </TableCell>
                    <TableCell>{lot.branchName}</TableCell>
                    <TableCell className="text-end font-mono">{lot.qtyOnHand}</TableCell>
                    <TableCell className="text-end">{formatMoney(lot.unitCost, settings.currency)}</TableCell>
                    <TableCell>{lot.expiryDate ? new Date(lot.expiryDate).toLocaleDateString() : "—"}</TableCell>
                    <TableCell>{statusBadge(lot.expiryStatus)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
