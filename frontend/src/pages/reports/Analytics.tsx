import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { BarChart3, Package, Warehouse, AlertTriangle, ShoppingCart } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useInventoryScope } from "@/hooks/queries/useInventoryScope";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useSettings } from "@/contexts/SettingsContext";

const PIE_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--chart-2, 173 58% 39%))",
  "hsl(var(--chart-3, 197 37% 24%))",
  "hsl(var(--chart-4, 43 74% 66%))",
  "hsl(var(--chart-5, 27 87% 67%))",
];

function monthKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function Analytics() {
  const { t } = useTranslation();
  const { products, branchProducts, branches, movements, getAvailableQuantity } = useInventoryScope({ products: true, movements: true });
  const { purchaseOrders } = usePurchasingScope({ purchaseOrders: true });
  const { settings } = useSettings();

  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "USD", maximumFractionDigits: 0 }).format(n);

  const stockValueByBranch = useMemo(() => {
    const map = new Map<string, number>();
    for (const bp of branchProducts) {
      const product = products.find((p) => p.productId === bp.productId);
      const cost = bp.costPrice || product?.costPrice || 0;
      const name = branches.find((b) => b.branchId === bp.branchId)?.branch_name || `Branch #${bp.branchId}`;
      map.set(name, (map.get(name) || 0) + bp.quantity * cost);
    }
    const pool = products.reduce((s, p) => s + getAvailableQuantity(p.productId) * p.costPrice, 0);
    if (pool > 0) map.set("General Pool", pool);
    return [...map.entries()].map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value);
  }, [branchProducts, products, branches, getAvailableQuantity]);

  const totalStockValue = stockValueByBranch.reduce((s, b) => s + b.value, 0);

  const lowStockCount = useMemo(
    () => products.filter((p) => p.quantity <= settings.lowStockThreshold).length,
    [products, settings.lowStockThreshold]
  );

  const topMovers = useMemo(() => {
    const map = new Map<string, { name: string; sku: string; units: number; count: number }>();
    for (const m of movements) {
      const cur = map.get(m.productId) || { name: m.product_name, sku: m.product_sku, units: 0, count: 0 };
      cur.units += Math.abs(m.quantity);
      cur.count += 1;
      map.set(m.productId, cur);
    }
    return [...map.values()].sort((a, b) => b.units - a.units).slice(0, 8);
  }, [movements]);

  const purchaseVolume = useMemo(() => {
    const map = new Map<string, { month: string; value: number; orders: number }>();
    for (const po of purchaseOrders) {
      if (po.status === "Draft" || po.status === "Cancelled") continue;
      const key = monthKey(po.orderDate);
      if (!key) continue;
      const cur = map.get(key) || { month: key, value: 0, orders: 0 };
      cur.value += po.grandTotal;
      cur.orders += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  }, [purchaseOrders]);

  const openPOValue = purchaseOrders
    .filter((po) => po.status === "Issued" || po.status === "Partially Received")
    .reduce((s, po) => s + po.grandTotal, 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <BarChart3 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t("pages.reports.analytics.title")}</h1>
            <p className="text-muted-foreground">{t("pages.reports.analytics.description")}</p>
          </div>
        </div>
        <Button variant="outline" asChild><Link to="/">{t("placeholder.backToDashboard")}</Link></Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardDescription>Stock value</CardDescription><Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{fmt(totalStockValue)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardDescription>Open PO value</CardDescription><ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{fmt(openPOValue)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardDescription>Locations</CardDescription><Warehouse className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{branches.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
            <CardDescription>Low stock items</CardDescription><AlertTriangle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{lowStockCount}</div></CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Stock value by location</CardTitle>
            <CardDescription>Quantity on hand valued at cost</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {stockValueByBranch.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">No stock data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stockValueByBranch}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Purchase volume</CardTitle>
            <CardDescription>Issued purchase orders per month</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {purchaseVolume.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">No purchase orders yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={purchaseVolume}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Legend />
                  <Line type="monotone" dataKey="value" name="PO value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Value distribution</CardTitle>
            <CardDescription>Share of stock value per location</CardDescription>
          </CardHeader>
          <CardContent className="h-[300px]">
            {stockValueByBranch.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground">No stock data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={stockValueByBranch} dataKey="value" nameKey="name" innerRadius={60} outerRadius={100} paddingAngle={2}>
                    {stockValueByBranch.map((entry, i) => (
                      <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top movers</CardTitle>
            <CardDescription>Most active products in the movement ledger</CardDescription>
          </CardHeader>
          <CardContent>
            {topMovers.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground">No movements recorded yet</div>
            ) : (
              <Table>
                <TableHeader><TableRow><TableHead>Product</TableHead><TableHead>SKU</TableHead><TableHead className="text-end">Units moved</TableHead><TableHead className="text-end">Movements</TableHead></TableRow></TableHeader>
                <TableBody>
                  {topMovers.map((m) => (
                    <TableRow key={m.sku}>
                      <TableCell className="font-medium">{m.name}</TableCell>
                      <TableCell className="font-mono text-xs">{m.sku}</TableCell>
                      <TableCell className="text-end">{m.units}</TableCell>
                      <TableCell className="text-end">{m.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}