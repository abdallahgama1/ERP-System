import { useMemo } from "react";
import { Clock, Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSales } from "@/contexts/SalesContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { downloadCsv, csvTimestamp } from "@/lib/export/csv";

const BUCKETS = ["Current", "1-30", "31-60", "61-90", "90+"] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketFor(dueDate: string): Bucket {
  const days = Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000);
  if (days <= 0) return "Current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export default function ARAging() {
  const { invoices } = useSales();
  const { settings } = useSettings();

  const rows = useMemo(() => {
    const map = new Map<string, Record<Bucket, number> & { customer: string; total: number }>();
    invoices
      .filter((i) => i.status !== "Draft" && i.status !== "Cancelled")
      .forEach((i) => {
        const bal = i.grandTotal - i.amountPaid;
        if (bal <= 0.005) return;
        const r = map.get(i.customerName) ?? { customer: i.customerName, total: 0, Current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
        r[bucketFor(i.dueDate)] += bal;
        r.total += bal;
        map.set(i.customerName, r);
      });
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [invoices]);

  const totals = BUCKETS.reduce((acc, b) => ({ ...acc, [b]: rows.reduce((s, r) => s + r[b], 0) }), {} as Record<Bucket, number>);
  const grand = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2"><Clock className="h-7 w-7 text-primary" />AR Aging</h1>
          <p className="text-muted-foreground">Unpaid customer invoice balances grouped by days past due.</p>
        </div>
        <Button variant="outline" disabled={!rows.length}
          onClick={() => downloadCsv(`ar-aging-${csvTimestamp()}`, rows, [
            { header: "Customer", value: (r) => r.customer },
            ...BUCKETS.map((b) => ({ header: b, value: (r: (typeof rows)[number]) => r[b].toFixed(2) })),
            { header: "Total", value: (r) => r.total.toFixed(2) },
          ])}>
          <Download className="h-4 w-4 me-2" />CSV
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
        {BUCKETS.map((b) => (
          <Card key={b}><CardHeader className="pb-2"><CardDescription>{b}</CardDescription><CardTitle className="text-xl">{formatMoney(totals[b], settings.currency)}</CardTitle></CardHeader></Card>
        ))}
        <Card><CardHeader className="pb-2"><CardDescription>Total outstanding</CardDescription><CardTitle className="text-xl">{formatMoney(grand, settings.currency)}</CardTitle></CardHeader></Card>
      </div>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No outstanding receivables.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Customer</TableHead>
                {BUCKETS.map((b) => <TableHead key={b} className="text-end">{b}</TableHead>)}
                <TableHead className="text-end">Total</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.customer}>
                    <TableCell className="font-medium">{r.customer}</TableCell>
                    {BUCKETS.map((b) => <TableCell key={b} className="text-end">{r[b] ? formatMoney(r[b], settings.currency) : "-"}</TableCell>)}
                    <TableCell className="text-end font-semibold">{formatMoney(r.total, settings.currency)}</TableCell>
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
