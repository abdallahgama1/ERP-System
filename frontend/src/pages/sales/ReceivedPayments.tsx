import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CreditCard, Plus, Ban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import type { PaymentMethod, ReceivedPayment } from "@/types";

const METHODS: PaymentMethod[] = ["cash", "bank", "card", "cheque"];
const today = () => new Date().toISOString().split("T")[0];

export default function ReceivedPayments() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const {
    customers,
    invoices,
    receivedPayments,
    createReceivedPayment,
    voidReceivedPayment,
    invoiceBalance,
    customerCredit,
  } = useSalesScope({ customers: true, invoices: true, receivedPayments: true });
  const { user } = useAuth();
  const { can } = usePermissions();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>("bank");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [amount, setAmount] = useState("");
  const [allocations, setAllocations] = useState<Record<string, number>>({});
  const [pendingVoid, setPendingVoid] = useState<ReceivedPayment | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const openInvoices = useMemo(
    () =>
      invoices.filter(
        (i) =>
          i.customerId === customerId &&
          i.status !== "Draft" &&
          i.status !== "Cancelled" &&
          invoiceBalance(i) > 0,
      ),
    [invoices, customerId, invoiceBalance],
  );

  const customersWithInvoices = useMemo(
    () =>
      customers.filter((c) =>
        invoices.some(
          (i) =>
            i.customerId === c.id &&
            i.status !== "Draft" &&
            i.status !== "Cancelled" &&
            invoiceBalance(i) > 0,
        ),
      ),
    [customers, invoices, invoiceBalance],
  );

  const totalAllocated = Object.values(allocations).reduce((s, n) => s + (n || 0), 0);
  const received = parseFloat(amount) || 0;
  const unapplied = Math.max(0, received - totalAllocated);

  const resetForm = () => {
    setCustomerId("");
    setPaymentDate(today());
    setMethod("bank");
    setReference("");
    setNotes("");
    setAmount("");
    setAllocations({});
  };

  const recordPaymentAction = useIdempotentAction(async () => {
    const rows = Object.entries(allocations)
      .map(([invoiceId, amt]) => ({ invoiceId, amount: amt }))
      .filter((r) => r.amount > 0);

    const result = await createReceivedPayment({
      customerId,
      paymentDate,
      method,
      reference: reference || undefined,
      notes: notes || undefined,
      createdBy: user?.name,
      amount: received,
      allocations: rows,
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return result;
    }
    toast({ title: `${result.payment.paymentNumber} ${t("sales.receivedPayments.recorded", "recorded")}` });
    setDialogOpen(false);
    resetForm();
    return { ok: true };
  });

  const voidPaymentAction = useIdempotentAction(async () => {
    if (!pendingVoid) return;
    const res = await voidReceivedPayment(pendingVoid.id, voidReason, user?.name || user?.email);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    toast({ title: `${pendingVoid.paymentNumber} ${t("common.voided", "voided")}` });
    setPendingVoid(null);
    setVoidReason("");
    return { ok: true };
  });

  const activePayments = receivedPayments.filter((p) => p.status !== "Voided");
  const totalReceived = activePayments.reduce((s, p) => s + p.amount, 0);
  const totalOutstanding = invoices
    .filter((i) => i.status !== "Draft" && i.status !== "Cancelled")
    .reduce((s, i) => s + invoiceBalance(i), 0);
  const totalCredit = customers.reduce((s, c) => s + customerCredit(c.id), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <CreditCard className="h-7 w-7" />
            {t("sales.receivedPayments.title", "Received Payments")}
          </h1>
          <p className="text-muted-foreground">
            {t("sales.receivedPayments.description", "Record customer payments and allocate them across open invoices.")}
          </p>
        </div>
        {can("sales", "create") && (
          <Button onClick={() => setDialogOpen(true)} disabled={customersWithInvoices.length === 0}>
            <Plus className="me-2 h-4 w-4" />
            {t("sales.receivedPayments.record", "Record Payment")}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("sales.receivedPayments.count", "Payments")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{activePayments.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("sales.receivedPayments.totalReceived", "Total received")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalReceived, settings.currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("sales.receivedPayments.outstanding", "Outstanding")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalOutstanding, settings.currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t("sales.receivedPayments.credit", "Customer credit")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalCredit, settings.currency)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("sales.receivedPayments.all", "All Payments")} ({receivedPayments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {receivedPayments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {t("sales.receivedPayments.empty", "No payments yet. Send an invoice first, then record a payment against it.")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sales.receivedPayments.number", "Payment #")}</TableHead>
                  <TableHead>{t("common.date", "Date")}</TableHead>
                  <TableHead>{t("sales.customer", "Customer")}</TableHead>
                  <TableHead>{t("sales.receivedPayments.method", "Method")}</TableHead>
                  <TableHead>{t("sales.receivedPayments.reference", "Reference")}</TableHead>
                  <TableHead>{t("sales.receivedPayments.invoices", "Invoices")}</TableHead>
                  <TableHead>{t("common.status", "Status")}</TableHead>
                  <TableHead className="text-end">{t("sales.receivedPayments.unapplied", "Unapplied")}</TableHead>
                  <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {receivedPayments.map((p) => {
                  const isVoided = p.status === "Voided";
                  return (
                    <TableRow key={p.id} className={isVoided ? "opacity-60" : undefined}>
                      <TableCell className="font-medium">{p.paymentNumber}</TableCell>
                      <TableCell>{p.paymentDate}</TableCell>
                      <TableCell>{p.customerName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{p.method}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.reference || "—"}</TableCell>
                      <TableCell className="text-sm">
                        {p.allocations.map((a) => a.invoiceNumber).join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={isVoided ? "destructive" : "secondary"}>
                          {isVoided ? t("common.voided", "Voided") : t("common.posted", "Posted")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end">
                        {p.unapplied > 0 && !isVoided ? formatMoney(p.unapplied, settings.currency) : "—"}
                      </TableCell>
                      <TableCell className="text-end font-medium">{formatMoney(p.amount, settings.currency)}</TableCell>
                      <TableCell>
                        {!isVoided && can("sales", "delete") && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Void ${p.paymentNumber}`}
                            title={t("common.void", "Void")}
                            onClick={() => {
                              setPendingVoid(p);
                              setVoidReason("");
                            }}
                          >
                            <Ban className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={recordPaymentAction.guardOpenChange((open) => { setDialogOpen(open); if (!open) resetForm(); })}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" locked={recordPaymentAction.isPending}>
          <DialogHeader>
            <DialogTitle>{t("sales.receivedPayments.record", "Record Payment")}</DialogTitle>
            <DialogDescription>
              {t("sales.receivedPayments.dialogHelp", "Allocate the payment across the customer's open invoices. Anything left over is held as customer credit.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("sales.customer", "Customer")} *</Label>
                <Select value={customerId} onValueChange={(v) => { setCustomerId(v); setAllocations({}); }}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("sales.selectCustomer", "Select a customer")} />
                  </SelectTrigger>
                  <SelectContent>
                    {customersWithInvoices.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("common.date", "Date")}</Label>
                <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t("sales.receivedPayments.method", "Method")}</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t("sales.receivedPayments.reference", "Reference")}</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Transfer / cheque #"
                  maxLength={60}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("sales.receivedPayments.amountReceived", "Amount received")} *</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>

            {customerId &&
              (openInvoices.length === 0 ? (
                <div className="rounded-md border py-6 text-center text-muted-foreground text-sm">
                  {t("sales.receivedPayments.noOpenInvoices", "This customer has no open invoices.")}
                </div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("sales.invoices.number", "Invoice #")}</TableHead>
                        <TableHead>{t("sales.invoices.dueDate", "Due")}</TableHead>
                        <TableHead className="text-end">{t("common.balance", "Balance")}</TableHead>
                        <TableHead className="w-36">{t("sales.receivedPayments.allocate", "Allocate")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openInvoices.map((inv) => {
                        const balance = invoiceBalance(inv);
                        return (
                          <TableRow key={inv.id}>
                            <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                            <TableCell>{inv.dueDate}</TableCell>
                            <TableCell className="text-end">{formatMoney(balance, settings.currency)}</TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                min={0}
                                max={balance}
                                step="0.01"
                                aria-label={`Amount to allocate to ${inv.invoiceNumber}`}
                                value={allocations[inv.id] ?? ""}
                                onChange={(e) => {
                                  const raw = parseFloat(e.target.value);
                                  const val = Number.isFinite(raw) ? Math.min(balance, Math.max(0, raw)) : 0;
                                  setAllocations((prev) => ({ ...prev, [inv.id]: val }));
                                }}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ))}

            <div className="flex flex-wrap justify-end gap-6 text-sm font-semibold">
              <span>
                {t("sales.receivedPayments.allocated", "Allocated")}: {formatMoney(totalAllocated, settings.currency)}
              </span>
              <span>
                {t("sales.receivedPayments.unapplied", "Unapplied")}: {formatMoney(unapplied, settings.currency)}
              </span>
            </div>
            {totalAllocated > received + 0.005 && (
              <p className="text-sm text-destructive text-end">
                {t("sales.receivedPayments.overAllocated", "Allocations exceed the amount received.")}
              </p>
            )}

            <div className="space-y-2">
              <Label>{t("common.notes", "Notes")}</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={recordPaymentAction.isPending} onClick={() => setDialogOpen(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <SubmitButton
              type="button"
              pending={recordPaymentAction.isPending}
              isSlow={recordPaymentAction.isSlow}
              onClick={() => void recordPaymentAction.run()}
              disabled={received <= 0 || totalAllocated > received + 0.005}
            >
              {t("sales.receivedPayments.record", "Record Payment")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingVoid} onOpenChange={voidPaymentAction.guardOpenChange((open) => !open && setPendingVoid(null))}>
        <DialogContent className="max-w-md" locked={voidPaymentAction.isPending}>
          <DialogHeader>
            <DialogTitle>
              {t("common.voidDocument", "Void")} {pendingVoid?.paymentNumber}
            </DialogTitle>
            <DialogDescription>
              {t(
                "sales.receivedPayments.voidDescription",
                "Voiding reverses the invoice payment allocations while preserving the numbered receipt record in the audit trail.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-rcp-reason">{t("common.reason", "Reason")} *</Label>
            <Textarea
              id="void-rcp-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder={t("common.voidReasonPlaceholder", "e.g. Entered in error, bounced cheque")}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={voidPaymentAction.isPending} onClick={() => setPendingVoid(null)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={voidPaymentAction.isPending}
              isSlow={voidPaymentAction.isSlow}
              onClick={() => void voidPaymentAction.run()}
              disabled={!voidReason.trim()}
            >
              {t("common.confirmVoid", "Confirm Void")}
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
