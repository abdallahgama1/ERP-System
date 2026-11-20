import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Package, Download, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInventory } from "@/contexts/InventoryContext";
import { useSettings } from "@/contexts/SettingsContext";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";

const GENERAL_POOL_ID = "__general__";
const GENERAL_POOL_NAME = "General Pool (unallocated)";

interface ValuationRow {
  key: string;
  productId: string;
  product_name: string;
  product_sku: string;
  category: string;
  branchId: string;
  branchName: string;
  quantity: number;
  costPrice: number;
  value: number;
}

export default function InventoryValuation() {
  const { t } = useTranslation();
  const { products, branchProducts, branches, getAvailableQuantity } = useInventory();
  const { settings } = useSettings();
  const [search, setSearch] = useState("");
  const [branchFilter, setBranchFilter] = useState<string>("all");

  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency: settings.currency || "USD" }).format(n);

  const allRows = useMemo<ValuationRow[]>(() => {
    const rows: ValuationRow[] = [];

    for (const bp of branchProducts) {
      const product = products.find((p) => p.productId === bp.productId);
      const branch = branches.find((b) => b.branchId === bp.branchId);
      const cost = bp.costPrice || product?.costPrice || 0;
      rows.push({
        key: `b-${bp.branchId}-${bp.productId}`,
        productId: bp.productId,
        product_name: bp.product_name || product?.product_name || "—",
        product_sku: bp.product_sku || product?.product_sku || "—",
        category: product?.category || "Uncategorized",
        branchId: bp.branchId,
        branchName: branch?.branch_name || `Branch #${bp.branchId}`,
        quantity: bp.quantity,
        costPrice: cost,
        value: bp.quantity * cost,
      });
    }

    for (const p of products) {
      const available = getAvailableQuantity(p.productId);
      if (available <= 0) continue;
      rows.push({
        key: `g-${p.productId}`,
        productId: p.productId,
        product_name: p.product_name,
        product_sku: p.product_sku,
        category: p.category || "Uncategorized",
        branchId: GENERAL_POOL_ID,
        branchName: GENERAL_POOL_NAME,
        quantity: available,
        costPrice: p.costPrice,
        value: available * p.costPrice,
      });
    }

    return rows;
  }, [products, branchProducts, branches, getAvailableQuantity]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (branchFilter !== "all" && String(r.branchId) !== branchFilter) return false;
      if (!q) return true;
      return (
        r.product_name.toLowerCase().includes(q) ||
        r.product_sku.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
      );
    });
  }, [allRows, search, branchFilter]);

  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalUnits = rows.reduce((s, r) => s + r.quantity, 0);

  const byBranch = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; value: number; lines: number }>();
    for (const r of rows) {
      const cur = map.get(r.branchName) || { name: r.branchName, qty: 0, value: 0, lines: 0 };
      cur.qty += r.quantity;
      cur.value += r.value;
      cur.lines += 1;
      map.set(r.branchName, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [rows]);

  const byCategory = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; value: number; lines: number }>();
    for (const r of rows) {
      const cur = map.get(r.category) || { name: r.category, qty: 0, value: 0, lines: 0 };
      cur.qty += r.quantity;
      cur.value += r.value;
      cur.lines += 1;
      map.set(r.category, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [rows]);

  const handleExport = () => {
    downloadCsv(`inventory-valuation-${csvTimestamp()}`, rows, [
      { header: "SKU", value: (r) => r.product_sku },
      { header: "Product", value: (r) => r.product_name },
      { header: "Category", value: (r) => r.category },
      { header: "Location", value: (r) => r.branchName },
      { header: "Quantity", value: (r) => r.quantity },
      { header: "Unit Cost", value: (r) => r.costPrice.toFixed(2) },
      { header: "Value", value: (r) => r.value.toFixed(2) },
    ]);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Package className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{t("pages.reports.inventoryValuation.title")}</h1>
            <p className="text-muted-foreground">{t("pages.reports.inventoryValuation.description")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleExport} disabled={rows.length === 0}>
            <Download className="h-4 w-4 me-2" />
            Export CSV
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">{t("placeholder.backToDashboard")}</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardDescription>Total Value</CardDescription><CardTitle className="text-2xl">{fmt(totalValue)}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Total Units</CardDescription><CardTitle className="text-2xl">{totalUnits.toLocaleString()}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Stock Lines</CardDescription><CardTitle className="text-2xl">{rows.length}</CardTitle></CardHeader></Card>
        <Card><CardHeader className="pb-2"><CardDescription>Locations</CardDescription><CardTitle className="text-2xl">{byBranch.length}</CardTitle></CardHeader></Card>
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="ps-9" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={branchFilter} onValueChange={setBranchFilter}>
              <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                <SelectItem value={String(GENERAL_POOL_ID)}>{GENERAL_POOL_NAME}</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="detail">
            <TabsList>
              <TabsTrigger value="detail">Detail</TabsTrigger>
              <TabsTrigger value="branch">By Location</TabsTrigger>
              <TabsTrigger value="category">By Category</TabsTrigger>
            </TabsList>

            <TabsContent value="detail">
              {rows.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">No stock matches the current filters</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="text-end">Qty</TableHead>
                      <TableHead className="text-end">Unit Cost</TableHead>
                      <TableHead className="text-end">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="font-mono text-xs">{r.product_sku}</TableCell>
                        <TableCell className="font-medium">{r.product_name}</TableCell>
                        <TableCell>{r.category}</TableCell>
                        <TableCell>{r.branchName}</TableCell>
                        <TableCell className="text-end">{r.quantity}</TableCell>
                        <TableCell className="text-end">{fmt(r.costPrice)}</TableCell>
                        <TableCell className="text-end font-medium">{fmt(r.value)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={4}>Grand total</TableCell>
                      <TableCell className="text-end">{totalUnits}</TableCell>
                      <TableCell />
                      <TableCell className="text-end font-bold">{fmt(totalValue)}</TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              )}
            </TabsContent>

            <TabsContent value="branch">
              <Table>
                <TableHeader><TableRow><TableHead>Location</TableHead><TableHead className="text-end">Lines</TableHead><TableHead className="text-end">Qty</TableHead><TableHead className="text-end">Value</TableHead></TableRow></TableHeader>
                <TableBody>
                  {byBranch.map((g) => (
                    <TableRow key={g.name}>
                      <TableCell className="font-medium">{g.name}</TableCell>
                      <TableCell className="text-end">{g.lines}</TableCell>
                      <TableCell className="text-end">{g.qty}</TableCell>
                      <TableCell className="text-end font-medium">{fmt(g.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="category">
              <Table>
                <TableHeader><TableRow><TableHead>Category</TableHead><TableHead className="text-end">Lines</TableHead><TableHead className="text-end">Qty</TableHead><TableHead className="text-end">Value</TableHead></TableRow></TableHeader>
                <TableBody>
                  {byCategory.map((g) => (
                    <TableRow key={g.name}>
                      <TableCell className="font-medium">{g.name}</TableCell>
                      <TableCell className="text-end">{g.lines}</TableCell>
                      <TableCell className="text-end">{g.qty}</TableCell>
                      <TableCell className="text-end font-medium">{fmt(g.value)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}