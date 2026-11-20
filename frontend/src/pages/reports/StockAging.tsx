import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Clock, Download, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useInventory } from "@/contexts/InventoryContext";
import { useSettings } from "@/contexts/SettingsContext";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";
import type { StockMovementType } from "@/types";

const INBOUND_TYPES: StockMovementType[] = [
  "initial",
  "assignment",
  "adjustment_in",
  "transfer_in",
  "purchase_receive",
  "receive_no_po",
  "return",
];

const BUCKETS = [
  { key: "0-30", label: "0–30 days", min: 0, max: 30 },
  { key: "31-60", label: "31–60 days", min: 31, max: 60 },
  { key: "61-90", label: "61–90 days", min: 61, max: 90 },
  { key: "90+", label: "90+ days", min: 91, max: Infinity },
] as const;

type BucketKey = (typeof BUCKETS)[number]["key"];

function bucketFor(days: number): BucketKey {
  const b = BUCKETS.find((x) => days >= x.min && days <= x.max);
  return (b?.key ?? "90+") as BucketKey;
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

interface AgingRow {
  key: string;
  product_name: string;
  product_sku: string;
  branchId: string;
  branchName: string;
  quantity: number;
  costPrice: number;
  value: number;
  lastInbound: string | null;
  days: number;
  bucket: BucketKey;
}

export default function StockAging() {
  const { t } = useTranslation();
  const { products, branchProducts, branches, movements } = useInventory();
  const { settings } = useSettings();
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [bucketFilter, setBucketFilter] = useState<string>("all");

  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "USD" }).format(n);

  /** last inbound movement date per `productId:branchId` */
  const lastInboundMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of movements) {
      if (!INBOUND_TYPES.includes(m.type) && m.quantity <= 0) continue;
      const key = `${m.productId}:${m.branchId ?? 0}`;
      const prev = map.get(key);
      if (!prev || new Date(m.createdAt) > new Date(prev)) map.set(key, m.createdAt);
    }
    return map;
  }, [movements]);

  const allRows = useMemo<AgingRow[]>(() => {
    return branchProducts
      .filter((bp) => bp.quantity > 0)
      .map((bp) => {
        const product = products.find((p) => p.productId === bp.productId);
        const branch = branches.find((b) => b.branchId === bp.branchId);
        const cost = bp.costPrice || product?.costPrice || 0;
        const lastInbound = lastInboundMap.get(`${bp.productId}:${bp.branchId}`) ?? null;
        const days = lastInbound ? daysSince(lastInbound) : 999;
        return {
          key: `${bp.branchId}-${bp.productId}`,
          product_name: bp.product_name || product?.product_name || "—",
          product_sku: bp.product_sku || product?.product_sku || "—",
          branchId: bp.branchId,
          branchName: branch?.branch_name || `Branch #${bp.branchId}`,
          quantity: bp.quantity,
          costPrice: cost,
          value: bp.quantity * cost,
          lastInbound,
          days,
          bucket: bucketFor(days),
        };
      })
      .sort((a, b) => b.days - a.days);
  }, [branchProducts, products, branches, lastInboundMap]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (branchFilter !== "all" && String(r.branchId) !== branchFilter) return false;
      if (bucketFilter !== "all" && r.bucket !== bucketFilter) return false;
      if (!q) return true;
      return r.product_name.toLowerCase().includes(q) || r.product_sku.toLowerCase().includes(q);
    });
  }, [allRows, search, branchFilter, bucketFilter]);

  const bucketTotals = useMemo(() => {
    const base = allRows.filter((r) => branchFilter === "all" || String(r.branchId) === branchFilter);
    return BUCKETS.map((b) => {
      const inBucket = base.filter((r) => r.bucket === b.key);
      return {
        ...b,
        qty: inBucket.reduce((s, r) => s + r.quantity, 0),
        value: inBucket.reduce((s, r) => s + r.value, 0),
        lines: inBucket.length,
      };
    });
  }, [allRows, branchFilter]);

  const slowMovers = rows.filter((r) => r.days > 90).length;

  const handleExport = () => {
    downloadCsv(`stock-aging-${csvTimestamp()}`, rows, [
      { header: "SKU", value: (r) => r.product_sku },
      { header: "Product", value: (r) => r.product_name },
      { header: "Branch", value: (r) => r.branchName },
      { header: "Quantity", value: (r) => r.quantity },
      { header: "Last Inbound", value: (r) => (r.lastInbound ? r.lastInbound.slice(0, 10) : "unknown") },
      { header: "Days On Shelf", value: (r) => r.days },
      { header: "Bucket", value: (r) => r.bucket },
      { header: "Value", value: (r) => r.value.toFixed(2) },
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
            <h1 className="text-3xl font-bold text-foreground">{t("pages.reports.stockAging.title")}</h1>
            <p className="text-muted-foreground">{t("pages.reports.stockAging.description")}</p>
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
              <p className="text-xs text-muted-foreground">{b.qty} units · {b.lines} lines</p>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>Aged stock</CardTitle>
          <CardDescription>{rows.length} lines · {slowMovers} slow movers over 90 days</CardDescription>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="ps-9" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            <div className="text-center py-12 text-muted-foreground">No stock matches the current filters</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-end">Qty</TableHead>
                  <TableHead>Last inbound</TableHead>
                  <TableHead className="text-end">Days</TableHead>
                  <TableHead>Bucket</TableHead>
                  <TableHead className="text-end">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-mono text-xs">{r.product_sku}</TableCell>
                    <TableCell className="font-medium">{r.product_name}</TableCell>
                    <TableCell>{r.branchName}</TableCell>
                    <TableCell className="text-end">{r.quantity}</TableCell>
                    <TableCell>{r.lastInbound ? r.lastInbound.slice(0, 10) : "Unknown"}</TableCell>
                    <TableCell className="text-end">{r.lastInbound ? r.days : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={r.bucket === "90+" ? "destructive" : r.bucket === "61-90" ? "secondary" : "outline"}>
                        {r.bucket}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end font-medium">{fmt(r.value)}</TableCell>
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