import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSales } from "@/contexts/SalesContext";
import { useInventory } from "@/contexts/InventoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { SalesReturn, SalesReturnDisposition, SalesReturnReason } from "@/types";

const REASONS: SalesReturnReason[] = ["damaged", "wrong_item", "expired", "not_needed", "other"];
const today = () => new Date().toISOString().split("T")[0];

type Line = { productId: string; product_name: string; product_sku: string; unitPrice: number; taxPercent: number; max: number; qty: number; disposition: SalesReturnDisposition };

export default function SalesReturns() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const money = (n: number) => formatMoney(n, settings.currency);
  const {
    customers, invoices, salesReturns, createSalesReturn, creditNoteBalance,
    applyCreditNoteToInvoice, returnedQtyForInvoice, invoiceBalance,
  } = useSales();
  const { branches } = useInventory();
  const { user } = useAuth();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [returnDate, setReturnDate] = useState(today());
  const [reason, setReason] = useState<SalesReturnReason>("damaged");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const [applyFor, setApplyFor] = useState<SalesReturn | null>(null);
  const [applyInvoiceId, setApplyInvoiceId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");

  const customerInvoices = useMemo(
    () => invoices.filter(i => i.customerId === customerId && i.status !== "Draft" && i.status !== "Cancelled"),
    [invoices, customerId],
  );

  const loadInvoiceLines = (id: string) => {
    setInvoiceId(id);
    const inv = invoices.find(i => i.id === id);
    if (!inv) return setLines([]);
    const already = returnedQtyForInvoice(inv.id);
    const next: Line[] = inv.items.map(item => {
      const max = Math.max(0, item.quantity - (already[item.productId] ?? 0));
      return {
        productId: item.productId,
        product_name: item.product_name,
        product_sku: item.product_sku,
        unitPrice: item.unitPrice,
        taxPercent: item.taxPercent,
        max,
        qty: 0,
        disposition: "restock" as SalesReturnDisposition,
      };
    }).filter(l => l.max > 0);
    setLines(next);
  };

  const creditPreview = lines.reduce((s, l) => s + l.qty * l.unitPrice * (1 + l.taxPercent / 100), 0);

  const resetForm = () => {
    setCustomerId(""); setInvoiceId(""); setBranchId(""); setReturnDate(today());
    setReason("damaged"); setNotes(""); setLines([]);
  };

  const submit = async () => {
    const result = await createSalesReturn({
      customerId,
      invoiceId: invoiceId || undefined,
      branchId,
      returnDate,
      reason,
      notes: notes || undefined,
      createdBy: user?.name,
      items: lines.filter(l => l.qty > 0).map(l => ({
        productId: l.productId,
        product_name: l.product_name,
        product_sku: l.product_sku,
        returnQty: l.qty,
        unitPrice: l.unitPrice,
        taxPercent: l.taxPercent,
        disposition: l.disposition,
      })),
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return;
    }
    toast({ title: `${result.salesReturn.returnNumber} ${t("sales.salesReturns.created", "created")}` });
    setOpen(false);
    resetForm();
  };

  const applyTargets = useMemo(
    () => (applyFor ? invoices.filter(i => i.customerId === applyFor.customerId && i.status !== "Draft" && i.status !== "Cancelled" && invoiceBalance(i) > 0) : []),
    [applyFor, invoices, invoiceBalance],
  );

  const submitApply = async () => {
    if (!applyFor) return;
    const res = await applyCreditNoteToInvoice(applyFor.id, applyInvoiceId, parseFloat(applyAmount) || 0);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return;
    }
    toast({ title: t("sales.salesReturns.creditApplied", "Credit applied") });
    setApplyFor(null); setApplyInvoiceId(""); setApplyAmount("");
  };

  const totalCredit = salesReturns.reduce((s, r) => s + r.creditTotal, 0);
  const remainingCredit = salesReturns.reduce((s, r) => s + creditNoteBalance(r), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t("sales.salesReturns.title", "Sales Returns")}</h1>
          <p className="text-muted-foreground">
            {t("sales.salesReturns.subtitle", "Take goods back, restock or write them off, and issue a credit note.")}
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("sales.salesReturns.new", "New Return")}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.salesReturns.count", "Returns")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{salesReturns.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.salesReturns.creditIssued", "Credit issued")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{money(totalCredit)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.salesReturns.creditRemaining", "Credit remaining")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{money(remainingCredit)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {salesReturns.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <RotateCcw className="h-10 w-10 mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">
                {t("sales.salesReturns.empty", "No returns yet. Create one against a sent invoice.")}
              </p>
              <Button onClick={() => setOpen(true)}>{t("sales.salesReturns.new", "New Return")}</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sales.salesReturns.number", "Return #")}</TableHead>
                  <TableHead>{t("common.date", "Date")}</TableHead>
                  <TableHead>{t("sales.customer", "Customer")}</TableHead>
                  <TableHead>{t("sales.invoices.number", "Invoice #")}</TableHead>
                  <TableHead>{t("common.branch", "Branch")}</TableHead>
                  <TableHead className="text-end">{t("sales.salesReturns.credit", "Credit")}</TableHead>
                  <TableHead className="text-end">{t("sales.salesReturns.remaining", "Remaining")}</TableHead>
                  <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salesReturns.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.returnNumber}</TableCell>
                    <TableCell>{r.returnDate}</TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell>{r.invoiceNumber ?? "—"}</TableCell>
                    <TableCell>{r.branchName}</TableCell>
                    <TableCell className="text-end">{money(r.creditTotal)}</TableCell>
                    <TableCell className="text-end">
                      {creditNoteBalance(r) > 0
                        ? <Badge variant="secondary">{money(creditNoteBalance(r))}</Badge>
                        : <Badge>{t("sales.salesReturns.fullyApplied", "Applied")}</Badge>}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={creditNoteBalance(r) <= 0}
                        onClick={() => { setApplyFor(r); setApplyAmount(creditNoteBalance(r).toFixed(2)); }}
                      >
                        {t("sales.salesReturns.applyCredit", "Apply credit")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("sales.salesReturns.new", "New Return")}</DialogTitle>
            <DialogDescription>
              {t("sales.salesReturns.dialogDesc", "Pick the invoice, the quantities coming back, and whether each line is resaleable.")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("sales.customer", "Customer")}</Label>
              <Select value={customerId} onValueChange={v => { setCustomerId(v); setInvoiceId(""); setLines([]); }}>
                <SelectTrigger><SelectValue placeholder={t("sales.selectCustomer", "Select customer")} /></SelectTrigger>
                <SelectContent>
                  {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("sales.invoices.number", "Invoice #")}</Label>
              <Select value={invoiceId} onValueChange={loadInvoiceLines} disabled={!customerId}>
                <SelectTrigger><SelectValue placeholder={t("sales.salesReturns.selectInvoice", "Select invoice")} /></SelectTrigger>
                <SelectContent>
                  {customerInvoices.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.invoiceNumber}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("sales.salesReturns.restockBranch", "Receiving branch")}</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger><SelectValue placeholder={t("common.selectBranch", "Select branch")} /></SelectTrigger>
                <SelectContent>
                  {branches.map(b => <SelectItem key={b.branchId} value={String(b.branchId)}>{b.branch_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("common.date", "Date")}</Label>
              <Input type="date" value={returnDate} onChange={e => setReturnDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t("sales.salesReturns.reason", "Reason")}</Label>
              <Select value={reason} onValueChange={v => setReason(v as SalesReturnReason)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REASONS.map(r => (
                    <SelectItem key={r} value={r}>{t(`sales.salesReturns.reasons.${r}`, r.replace("_", " "))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>{t("common.notes", "Notes")}</Label>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
            </div>
          </div>

          {lines.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.product", "Product")}</TableHead>
                  <TableHead className="text-end">{t("sales.salesReturns.returnable", "Returnable")}</TableHead>
                  <TableHead className="text-end">{t("sales.salesReturns.returnQty", "Return qty")}</TableHead>
                  <TableHead>{t("sales.salesReturns.disposition", "Disposition")}</TableHead>
                  <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => (
                  <TableRow key={l.productId}>
                    <TableCell>
                      <div className="font-medium">{l.product_name}</div>
                      <div className="text-xs text-muted-foreground">{l.product_sku}</div>
                    </TableCell>
                    <TableCell className="text-end">{l.max}</TableCell>
                    <TableCell className="text-end">
                      <Input
                        type="number"
                        min={0}
                        max={l.max}
                        value={l.qty}
                        className="w-24 ms-auto text-end"
                        onChange={e => {
                          const qty = Math.max(0, Math.min(l.max, parseInt(e.target.value, 10) || 0));
                          setLines(prev => prev.map((p, i) => (i === idx ? { ...p, qty } : p)));
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={l.disposition}
                        onValueChange={v => setLines(prev => prev.map((p, i) => (i === idx ? { ...p, disposition: v as SalesReturnDisposition } : p)))}
                      >
                        <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="restock">{t("sales.salesReturns.restock", "Restock")}</SelectItem>
                          <SelectItem value="write_off">{t("sales.salesReturns.writeOff", "Write off")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-end">{money(l.qty * l.unitPrice * (1 + l.taxPercent / 100))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="flex justify-end text-sm">
            <span className="text-muted-foreground me-2">{t("sales.salesReturns.creditNote", "Credit note total")}:</span>
            <span className="font-semibold">{money(creditPreview)}</span>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel", "Cancel")}</Button>
            <Button onClick={submit} disabled={!customerId || !branchId || creditPreview <= 0}>
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!applyFor} onOpenChange={o => { if (!o) { setApplyFor(null); setApplyInvoiceId(""); setApplyAmount(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sales.salesReturns.applyCredit", "Apply credit")}</DialogTitle>
            <DialogDescription>
              {applyFor ? `${applyFor.returnNumber} — ${money(creditNoteBalance(applyFor))}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("sales.invoices.number", "Invoice #")}</Label>
              <Select value={applyInvoiceId} onValueChange={setApplyInvoiceId}>
                <SelectTrigger><SelectValue placeholder={t("sales.salesReturns.selectInvoice", "Select invoice")} /></SelectTrigger>
                <SelectContent>
                  {applyTargets.map(i => (
                    <SelectItem key={i.id} value={String(i.id)}>{i.invoiceNumber} — {money(invoiceBalance(i))}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("common.amount", "Amount")}</Label>
              <Input type="number" min={0} step="0.01" value={applyAmount} onChange={e => setApplyAmount(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyFor(null)}>{t("common.cancel", "Cancel")}</Button>
            <Button onClick={submitApply} disabled={!applyInvoiceId}>{t("common.save", "Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
