import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Clock, Download, Search, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useSettings } from "@/contexts/SettingsContext";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";

const BUCKETS = [
  { key: "0-30", label: "0–30 days", min: 0, max: 30 },
  { key: "31-60", label: "31–60 days", min: 31, max: 60 },
  { key: "61-90", label: "61–90 days", min: 61, max: 90 },
  { key: "90+", label: "90+ days", min: 91, max: Infinity },
] as const;

type BucketKey = (typeof BUCKETS)[number]["key"];

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

export default function POAging() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { purchaseOrders } = usePurchasingScope({ purchaseOrders: true, vendors: true });
  const { settings } = useSettings();
  const [search, setSearch] = useState("");
  const [bucketFilter, setBucketFilter] = useState<string>("all");

  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "USD" }).format(n);

  const allRows = useMemo(() => {
    return purchaseOrders
      .filter((po) => po.status === "Issued" || po.status === "Partially Received")
      .map((po) => {
        const outstandingQty = po.items.reduce((s, i) => s + Math.max(0, i.quantity - i.receivedQty), 0);
        const outstandingValue = po.items.reduce(
          (s, i) => s + Math.max(0, i.quantity - i.receivedQty) * i.unitPrice,
          0
        );
        const age = daysSince(po.orderDate);
        const bucket = (BUCKETS.find((b) => age >= b.min && age <= b.max)?.key ?? "90+") as BucketKey;
        const expected = new Date(po.expectedDate).getTime();
        const overdue = !Number.isNaN(expected) && expected < Date.now();
        const daysOverdue = overdue ? daysSince(po.expectedDate) : 0;
        return { po, outstandingQty, outstandingValue, age, bucket, overdue, daysOverdue };
      })
      .filter((r) => r.outstandingQty > 0)
      .sort((a, b) => b.age - a.age);
  }, [purchaseOrders]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (bucketFilter !== "all" && r.bucket !== bucketFilter) return false;
      if (!q) return true;
      return r.po.poNumber.toLowerCase().includes(q) || r.po.vendorName.toLowerCase().includes(q);
    });
  }, [allRows, search, bucketFilter]);

  const bucketTotals = BUCKETS.map((b) => {
    const inBucket = allRows.filter((r) => r.bucket === b.key);
    return { ...b, count: inBucket.length, value: inBucket.reduce((s, r) => s + r.outstandingValue, 0) };
  });

  const overdueCount = allRows.filter((r) => r.overdue).length;
  const totalOutstanding = rows.reduce((s, r) => s + r.outstandingValue, 0);

  const handleExport = () => {
    downloadCsv(`po-aging-${csvTimestamp()}`, rows, [
      { header: "PO #", value: (r) => r.po.poNumber },
      { header: "Vendor", value: (r) => r.po.vendorName },
      { header: "Order Date", value: (r) => r.po.orderDate },
      { header: "Expected Date", value: (r) => r.po.expectedDate },
      { header: "Status", value: (r) => r.po.status },
      { header: "Age (days)", value: (r) => r.age },
      { header: "Bucket", value: (r) => r.bucket },
      { header: "Days Overdue", value: (r) => r.daysOverdue },
      { header: "Outstanding Qty", value: (r) => r.outstandingQty },
      { header: "Outstanding Value", value: (r) => r.outstandingValue.toFixed(2) },
    ]);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Clock className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t("pages.reports.poAging.title")}</h1>
            <p className="text-muted-foreground">{t("pages.reports.poAging.description")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} disabled={rows.length === 0}>
            <Download className="h-4 w-4 me-2" />
            Export CSV
          </Button>
          <Button variant="outline" asChild><Link to="/">{t("placeholder.backToDashboard")}</Link></Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {bucketTotals.map((b) => (
          <Card
            key={b.key}
            role="button"
            tabIndex={0}
            onClick={() => setBucketFilter(bucketFilter === b.key ? "all" : b.key)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setBucketFilter(bucketFilter === b.key ? "all" : b.key); }}
            className={`cursor-pointer transition-colors ${bucketFilter === b.key ? "border-primary" : ""}`}
          >
            <CardHeader className="pb-2">
              <CardDescription>{b.label}</CardDescription>
              <CardTitle className="text-2xl">{fmt(b.value)}</CardTitle>
              <p className="text-xs text-muted-foreground">{b.count} open orders</p>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Open purchase orders</CardTitle>
          <CardDescription className="flex items-center gap-2">
            {rows.length} orders · {fmt(totalOutstanding)} outstanding
            {overdueCount > 0 && (
              <span className="inline-flex items-center gap-1 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                {overdueCount} past expected date
              </span>
            )}
          </CardDescription>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="ps-9" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={bucketFilter} onValueChange={setBucketFilter}>
              <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All buckets</SelectItem>
                {BUCKETS.map((b) => (<SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No open purchase orders with outstanding quantity</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Ordered</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Age</TableHead>
                  <TableHead className="text-end">Outstanding qty</TableHead>
                  <TableHead className="text-end">Outstanding value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.po.id} className="cursor-pointer" onClick={() => navigate(`/purchases/orders/${r.po.id}`)}>
                    <TableCell className="font-medium">{r.po.poNumber}</TableCell>
                    <TableCell>{r.po.vendorName}</TableCell>
                    <TableCell>{r.po.orderDate}</TableCell>
                    <TableCell className={r.overdue ? "text-destructive font-medium" : ""}>
                      {r.po.expectedDate}
                      {r.overdue && <span className="ms-2 text-xs">({r.daysOverdue}d late)</span>}
                    </TableCell>
                    <TableCell><Badge variant="outline">{r.po.status}</Badge></TableCell>
                    <TableCell className="text-end">{r.age}d</TableCell>
                    <TableCell className="text-end">{r.outstandingQty}</TableCell>
                    <TableCell className="text-end font-medium">{fmt(r.outstandingValue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={7}>Total outstanding</TableCell>
                  <TableCell className="text-end font-bold">{fmt(totalOutstanding)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}