import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Receipt, Plus, Send, Ban, Trash2, Wallet, Download } from "lucide-react";
import { downloadInvoicePdf } from "@/lib/pdf/invoicePdf";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ProductSelector } from "@/components/purchases/ProductSelector";
import { useSales } from "@/contexts/SalesContext";
import { useInventory } from "@/contexts/InventoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { Customer, Invoice, InvoiceStatus } from "@/types";

const statusVariant: Record<InvoiceStatus, "default" | "secondary" | "outline" | "destructive"> = {
  Draft: "secondary",
  Sent: "default",
  "Partially Paid": "outline",
  Paid: "secondary",
  Overdue: "destructive",
  Cancelled: "outline",
};

const today = () => new Date().toISOString().split("T")[0];
const addDays = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
};

interface DraftLine {
  productId: string;
  product_name: string;
  product_sku: string;
  quantity: number;
  unitPrice: number;
  taxPercent: number;
}

export default function Invoices() {
  const { t } = useTranslation();
  const { invoices, customers, salesOrders, createInvoice, sendInvoice, cancelInvoice, deleteInvoice, recordInvoicePayment, invoiceBalance } = useSales();
  const { products } = useInventory();
  const { user } = useAuth();
  const { settings, taxCodes } = useSettings();
  const { toast } = useToast();
  const defaultTaxRate = useMemo(
    () => (taxCodes.find((tc) => tc.isDefault && tc.isActive) ?? taxCodes.find((tc) => tc.isActive))?.rate ?? 0,
    [taxCodes]
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [soId, setSoId] = useState<string>("none");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [dueDate, setDueDate] = useState(addDays(30));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Invoice | null>(null);
  const [payFor, setPayFor] = useState<Invoice | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const invoicedSoIds = useMemo(
    () => new Set(invoices.map(i => i.salesOrderId).filter((v): v is string => typeof v === "string" && v.length > 0)),
    [invoices],
  );

  const eligibleOrders = useMemo(
    () =>
      salesOrders.filter(
        o => !invoicedSoIds.has(o.id) && o.status !== "Draft" && o.status !== "Cancelled" &&
          (customerId ? o.customerId === customerId : true),
      ),
    [salesOrders, invoicedSoIds, customerId],
  );

  const currency = customers.find(c => c.id === customerId)?.currency || settings.currency;
  const fmt = (n: number, cur = currency) => formatMoney(n, cur || settings.currency);

  const resetForm = () => {
    setCustomerId(null);
    setSoId("none");
    setInvoiceDate(today());
    setDueDate(addDays(30));
    setNotes("");
    setLines([]);
  };

  const pickCustomer = (customer: Customer) => {
    setCustomerId(customer.id);
    setSoId("none");
    setDueDate(addDays(customer.paymentTerms === "NET15" ? 15 : customer.paymentTerms === "COD" ? 0 : 30));
  };

  const pickOrder = (value: string) => {
    setSoId(value);
    if (value === "none") { setLines([]); return; }
    const order = salesOrders.find(o => o.id === value);
    if (!order) return;
    setCustomerId(order.customerId);
    setLines(
      order.items.map(i => ({
        productId: i.productId,
        product_name: i.product_name,
        product_sku: i.product_sku,
        quantity: i.fulfilledQty > 0 ? i.fulfilledQty : i.quantity,
        unitPrice: i.unitPrice,
        taxPercent: i.taxPercent,
      })),
    );
  };

  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines(prev => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const totalTax = lines.reduce((s, l) => s + (l.quantity * l.unitPrice * l.taxPercent) / 100, 0);

  const handleSubmit = async () => {
    const customer = customers.find(c => c.id === customerId);
    if (!customer) {
      toast({ title: t("invoices.selectCustomer", "Select a customer"), variant: "destructive" });
      return;
    }
    const order = soId !== "none" ? salesOrders.find(o => o.id === soId) : undefined;
    const result = await createInvoice({
      customerId: customer.id,
      customerName: customer.displayName,
      salesOrderId: order?.id,
      soNumber: order?.soNumber,
      invoiceDate,
      dueDate,
      notes: notes || undefined,
      createdBy: user?.name,
      items: lines,
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return;
    }
    toast({ title: `${result.invoice.invoiceNumber} ${t("invoices.created", "created")}` });
    setDialogOpen(false);
    resetForm();
  };

  const act = async (promise: Promise<{ ok: true } | { ok: false; error: string }>, okTitle: string) => {
    const res = await promise;
    if (res.ok === false) toast({ title: res.error, variant: "destructive" });
    else toast({ title: okTitle });
  };

  const outstanding = invoices
    .filter(i => i.status !== "Draft" && i.status !== "Cancelled")
    .reduce((s, i) => s + invoiceBalance(i), 0);
  const overdueCount = invoices.filter(i => i.status === "Overdue").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Receipt className="h-7 w-7" />
            {t("nav.sales.invoices")}
          </h1>
          <p className="text-muted-foreground">
            {t("invoices.description", "Customer invoices, receivables and payment status.")}
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} disabled={customers.length === 0}>
          <Plus className="me-2 h-4 w-4" />
          {t("invoices.new", "New Invoice")}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.count", "Invoices")}</CardDescription><CardTitle className="text-2xl">{invoices.length}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.outstanding", "Outstanding")}</CardDescription><CardTitle className="text-2xl">{fmt(outstanding, "USD")}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>{t("invoices.overdue", "Overdue")}</CardDescription><CardTitle className="text-2xl">{overdueCount}</CardTitle></CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t("nav.sales.invoices")} ({invoices.length})</CardTitle></CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              <Receipt className="h-10 w-10 mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">
                {t("invoices.empty", "No invoices yet. Raise one from a confirmed sales order to start tracking receivables.")}
              </p>
              <Button onClick={() => setDialogOpen(true)} disabled={customers.length === 0}>
                <Plus className="me-2 h-4 w-4" />{t("invoices.new", "New Invoice")}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("invoices.number", "Invoice #")}</TableHead>
                  <TableHead>{t("invoices.customer", "Customer")}</TableHead>
                  <TableHead>{t("invoices.invoiceDate", "Invoice Date")}</TableHead>
                  <TableHead>{t("invoices.dueDate", "Due Date")}</TableHead>
                  <TableHead>{t("salesOrders.soNumber")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                  <TableHead className="text-end">{t("invoices.balance", "Balance")}</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map(inv => (
                  <TableRow key={inv.id} className="cursor-pointer" onClick={() => setDetail(inv)}>
                    <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                    <TableCell>{inv.customerName}</TableCell>
                    <TableCell>{new Date(inv.invoiceDate).toLocaleDateString()}</TableCell>
                    <TableCell>{new Date(inv.dueDate).toLocaleDateString()}</TableCell>
                    <TableCell>{inv.soNumber || "-"}</TableCell>
                    <TableCell><Badge variant={statusVariant[inv.status]}>{inv.status}</Badge></TableCell>
                    <TableCell className="text-end">{formatMoney(inv.grandTotal, settings.currency)}</TableCell>
                    <TableCell className="text-end font-medium">{formatMoney(invoiceBalance(inv), settings.currency)}</TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" aria-label={`Download ${inv.invoiceNumber} PDF`}
                          onClick={() => downloadInvoicePdf(inv, settings.currency)}>
                          <Download className="h-4 w-4" />
                        </Button>
                        {inv.status === "Draft" && (
                          <Button variant="ghost" size="icon" aria-label={`Send ${inv.invoiceNumber}`}
                            onClick={() => act(sendInvoice(inv.id), `${inv.invoiceNumber} sent`)}>
                            <Send className="h-4 w-4" />
                          </Button>
                        )}
                        {inv.status !== "Draft" && inv.status !== "Paid" && inv.status !== "Cancelled" && (
                          <Button variant="ghost" size="icon" aria-label={`Record payment for ${inv.invoiceNumber}`}
                            onClick={() => { setPayFor(inv); setPayAmount(invoiceBalance(inv).toFixed(2)); }}>
                            <Wallet className="h-4 w-4" />
                          </Button>
                        )}
                        {inv.status !== "Cancelled" && inv.amountPaid === 0 && (
                          <Button variant="ghost" size="icon" aria-label={`Cancel ${inv.invoiceNumber}`}
                            onClick={() => act(cancelInvoice(inv.id), `${inv.invoiceNumber} cancelled`)}>
                            <Ban className="h-4 w-4" />
                          </Button>
                        )}
                        {inv.status === "Draft" && (
                          <Button variant="ghost" size="icon" aria-label={`Delete ${inv.invoiceNumber}`}
                            onClick={() => setPendingDelete(inv)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={open => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("invoices.new", "New Invoice")}</DialogTitle>
            <DialogDescription>
              {t("invoices.newDescription", "Raise an invoice from a sales order, or build one line by line.")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("invoices.customer", "Customer")}</Label>
              <Select
                value={customerId ? String(customerId) : ""}
                onValueChange={value => {
                  const customer = customers.find(c => c.id === value);
                  if (customer) pickCustomer(customer);
                }}
              >
                <SelectTrigger aria-label={t("invoices.customer", "Customer")}>
                  <SelectValue placeholder={t("salesOrders.selectCustomer")} />
                </SelectTrigger>
                <SelectContent>
                  {customers.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("salesOrders.soNumber")}</Label>
              <Select value={soId} onValueChange={pickOrder}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("invoices.noOrder", "Without a sales order")}</SelectItem>
                  {eligibleOrders.map(o => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.soNumber} — {o.customerName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-date">{t("invoices.invoiceDate", "Invoice Date")}</Label>
              <Input id="inv-date" type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-due">{t("invoices.dueDate", "Due Date")}</Label>
              <Input id="inv-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-3">
            <Label>{t("invoices.lineItems", "Line Items")}</Label>
            <ProductSelector
              products={products}
              onSelect={p =>
                setLines(prev => [
                  ...prev,
                  {
                    productId: p.productId,
                    product_name: p.product_name,
                    product_sku: p.product_sku,
                    quantity: 1,
                    unitPrice: p.sellingPrice,
                    taxPercent: defaultTaxRate,
                  },
                ])
              }
            />
            <datalist id="inv-tax-codes">
              {taxCodes.map((tc) => (
                <option key={tc.id} value={tc.rate}>
                  {tc.code} ({tc.rate}%)
                </option>
              ))}
            </datalist>
            {lines.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("invoices.item", "Item")}</TableHead>
                    <TableHead className="w-24">{t("common.quantity", "Qty")}</TableHead>
                    <TableHead className="w-28">{t("invoices.unitPrice", "Price")}</TableHead>
                    <TableHead className="w-24">{t("invoices.tax", "Tax %")}</TableHead>
                    <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, i) => (
                    <TableRow key={`${l.productId}-${i}`}>
                      <TableCell>
                        <div className="font-medium">{l.product_name}</div>
                        <div className="text-xs text-muted-foreground">{l.product_sku}</div>
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={1} value={l.quantity}
                          onChange={e => updateLine(i, { quantity: Math.max(1, Number(e.target.value) || 0) })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={0} step="0.01" value={l.unitPrice}
                          onChange={e => updateLine(i, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} />
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={0} max={100} list="inv-tax-codes" value={l.taxPercent}
                          onChange={e => updateLine(i, { taxPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} />
                      </TableCell>
                      <TableCell className="text-end">
                        {fmt(l.quantity * l.unitPrice * (1 + l.taxPercent / 100))}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" aria-label={`Remove ${l.product_name}`}
                          onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="inv-notes">{t("common.notes", "Notes")}</Label>
              <Textarea id="inv-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={3} />
            </div>
            <div className="space-y-1 text-sm self-end">
              <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.subtotal", "Subtotal")}</span><span>{fmt(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.totalTax", "Total Tax")}</span><span>{fmt(totalTax)}</span></div>
              <div className="flex justify-between font-semibold text-base"><span>{t("invoices.grandTotal", "Grand Total")}</span><span>{fmt(subtotal + totalTax)}</span></div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleSubmit}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={open => !open && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detail.invoiceNumber}
                  <Badge variant={statusVariant[detail.status]}>{detail.status}</Badge>
                </DialogTitle>
                <DialogDescription>
                  {detail.customerName}
                  {detail.soNumber ? ` — ${detail.soNumber}` : ""}
                </DialogDescription>
              </DialogHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("invoices.item", "Item")}</TableHead>
                    <TableHead className="text-end">{t("common.quantity", "Qty")}</TableHead>
                    <TableHead className="text-end">{t("invoices.unitPrice", "Price")}</TableHead>
                    <TableHead className="text-end">{t("invoices.amount", "Amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map(item => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div className="font-medium">{item.product_name}</div>
                        <div className="text-xs text-muted-foreground">{item.product_sku}</div>
                      </TableCell>
                      <TableCell className="text-end">{item.quantity}</TableCell>
                      <TableCell className="text-end">{formatMoney(item.unitPrice, settings.currency)}</TableCell>
                      <TableCell className="text-end">{formatMoney(item.amount, settings.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.subtotal", "Subtotal")}</span><span>{formatMoney(detail.subtotal, settings.currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.totalTax", "Total Tax")}</span><span>{formatMoney(detail.totalTax, settings.currency)}</span></div>
                <div className="flex justify-between font-semibold"><span>{t("invoices.grandTotal", "Grand Total")}</span><span>{formatMoney(detail.grandTotal, settings.currency)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">{t("invoices.paid", "Paid")}</span><span>{formatMoney(detail.amountPaid, settings.currency)}</span></div>
                <div className="flex justify-between font-semibold"><span>{t("invoices.balance", "Balance")}</span><span>{formatMoney(invoiceBalance(detail), settings.currency)}</span></div>
              </div>
              {detail.notes && <p className="text-sm whitespace-pre-line text-muted-foreground">{detail.notes}</p>}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Payment dialog */}
      <Dialog open={!!payFor} onOpenChange={open => !open && setPayFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("invoices.recordPayment", "Record Payment")}</DialogTitle>
            <DialogDescription>
              {payFor ? `${payFor.invoiceNumber} — ${t("invoices.balance", "Balance")} ${formatMoney(invoiceBalance(payFor), settings.currency)}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pay-amount">{t("invoices.amount", "Amount")}</Label>
            <Input id="pay-amount" type="number" min={0} step="0.01" value={payAmount}
              onChange={e => setPayAmount(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>{t("common.cancel")}</Button>
            <Button
              onClick={async () => {
                if (!payFor) return;
                const res = await recordInvoicePayment(payFor.id, Number(payAmount));
                if (res.ok === false) { toast({ title: res.error, variant: "destructive" }); return; }
                toast({ title: t("invoices.paymentRecorded", "Payment recorded") });
                setPayFor(null);
              }}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={!!pendingDelete}
        onOpenChange={open => !open && setPendingDelete(null)}
        itemName={pendingDelete?.invoiceNumber ?? ""}
        onConfirm={async () => {
          if (pendingDelete) {
            const res = await deleteInvoice(pendingDelete.id);
            if (res.ok === false) toast({ title: res.error, variant: "destructive" });
            else toast({ title: `${pendingDelete.invoiceNumber} deleted` });
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
