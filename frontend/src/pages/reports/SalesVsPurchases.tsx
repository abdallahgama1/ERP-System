import { useMemo } from "react";
import { TrendingUp, Download } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useSettings } from "@/contexts/SettingsContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useProfitLossQuery } from "@/hooks/queries/useAccountingQueries";
import { formatMoney } from "@/lib/money";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";

type Row = { month: string; sales: number; purchases: number; margin: number; marginPct: number };

export default function SalesVsPurchases() {
  const { invoices } = useSalesScope({ invoices: true });
  const { bills } = usePurchasingScope({ bills: true });
  const { settings } = useSettings();
  const { can } = usePermissions();
  const { data: pnl } = useProfitLossQuery({}, can("accounting", "view"));

  const rows = useMemo<Row[]>(() => {
    const m = new Map<string, { sales: number; purchases: number }>();
    const add = (date: string, k: "sales" | "purchases", v: number) => {
      const key = date.slice(0, 7);
      const r = m.get(key) ?? { sales: 0, purchases: 0 };
      r[k] += v;
      m.set(key, r);
    };
    invoices
      .filter((i) => i.status !== "Draft" && i.status !== "Cancelled" && i.source !== "opening_balance")
      .forEach((i) => add(i.invoiceDate, "sales", i.subtotal));
    bills
      .filter((b) => b.status !== "Draft" && b.status !== "Cancelled" && b.source !== "opening_balance")
      .forEach((b) => add(b.billDate, "purchases", b.subtotal));
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, r]) => {
      const margin = r.sales - r.purchases;
      return { month, ...r, margin, marginPct: r.sales ? (margin / r.sales) * 100 : 0 };
    });
  }, [invoices, bills]);

  const tot = rows.reduce((a, r) => ({ sales: a.sales + r.sales, purchases: a.purchases + r.purchases }), { sales: 0, purchases: 0 });
  const margin = tot.sales - tot.purchases;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><TrendingUp className="h-7 w-7 text-primary" />Sales vs Purchases</h1>
          <p className="text-muted-foreground">Invoiced sales against vendor bills per month (before tax).</p>
        </div>
        <Button variant="outline" disabled={!rows.length}
          onClick={() => downloadCsv(`sales-vs-purchases-${csvTimestamp()}`, rows, [
            { header: "Month", value: (r) => r.month },
            { header: "Sales", value: (r) => r.sales.toFixed(2) },
            { header: "Purchases", value: (r) => r.purchases.toFixed(2) },
            { header: "Margin", value: (r) => r.margin.toFixed(2) },
            { header: "Margin %", value: (r) => r.marginPct.toFixed(1) },
          ])}>
          <Download className="h-4 w-4 me-2" />CSV
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {([
          ["Sales", tot.sales],
          ["Purchases", tot.purchases],
          [pnl && (pnl.cogsTotal > 0 || pnl.totalRevenue > 0) ? "GL Gross Profit (COGS)" : "Cash-flow margin", pnl && (pnl.cogsTotal > 0 || pnl.totalRevenue > 0) ? pnl.grossProfit : margin],
        ] as Array<[string, number]>).map(([k, v]) => (
          <Card key={k}><CardHeader className="pb-2"><CardDescription>{k}</CardDescription><CardTitle className="text-2xl">{formatMoney(v, settings.currency)}</CardTitle></CardHeader></Card>
        ))}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Margin % {pnl && pnl.cogsTotal > 0 ? `(COGS: ${formatMoney(pnl.cogsTotal, settings.currency)})` : ""}</CardDescription>
            <CardTitle className="text-2xl">
              {pnl && pnl.totalRevenue > 0
                ? ((pnl.grossProfit / pnl.totalRevenue) * 100).toFixed(1)
                : tot.sales
                  ? ((margin / tot.sales) * 100).toFixed(1)
                  : "0.0"}%
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Monthly trend</CardTitle></CardHeader>
        <CardContent className="h-80">
          {rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-16">No invoices or bills yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="sales" name="Sales" fill="hsl(var(--primary))" />
                <Bar dataKey="purchases" name="Purchases" fill="hsl(var(--muted-foreground))" />
                <Line dataKey="margin" name="Margin" stroke="hsl(var(--destructive))" />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      {rows.length > 0 && (
        <Card><CardContent className="pt-6">
          <Table>
            <TableHeader><TableRow><TableHead>Month</TableHead><TableHead className="text-end">Sales</TableHead><TableHead className="text-end">Purchases</TableHead><TableHead className="text-end">Margin</TableHead><TableHead className="text-end">Margin %</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.month}>
                  <TableCell>{r.month}</TableCell>
                  <TableCell className="text-end">{formatMoney(r.sales, settings.currency)}</TableCell>
                  <TableCell className="text-end">{formatMoney(r.purchases, settings.currency)}</TableCell>
                  <TableCell className="text-end font-medium">{formatMoney(r.margin, settings.currency)}</TableCell>
                  <TableCell className="text-end">{r.marginPct.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
    </div>
  );
}
