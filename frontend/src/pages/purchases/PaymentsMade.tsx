import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Wallet, Plus, Ban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePurchasingScope } from "@/hooks/queries/usePurchasingScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import { SubmitButton } from "@/components/ui/submit-button";
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import type { PaymentMade, PaymentMethod } from "@/types";

const METHODS: PaymentMethod[] = ["cash", "bank", "card", "cheque"];
const today = () => new Date().toISOString().split("T")[0];

export default function PaymentsMade() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const { can } = usePermissions();
  const { bills, payments, vendors, createPayment, voidPayment, billBalance } = usePurchasingScope({ bills: true, payments: true, vendors: true });
  const { user } = useAuth();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>("bank");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [allocations, setAllocations] = useState<Record<number, number>>({});
  const [pendingVoid, setPendingVoid] = useState<PaymentMade | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const openBills = useMemo(
    () =>
      bills.filter(
        (b) => b.vendorId === vendorId && b.status !== "Cancelled" && b.status !== "Draft" && billBalance(b) > 0,
      ),
    [bills, vendorId, billBalance],
  );

  const vendorsWithBills = useMemo(
    () =>
      vendors.filter((v) =>
        bills.some((b) => b.vendorId === v.id && b.status !== "Cancelled" && b.status !== "Draft" && billBalance(b) > 0),
      ),
    [vendors, bills, billBalance],
  );

  const totalAllocated = Object.values(allocations).reduce((s, n) => s + (n || 0), 0);

  const resetForm = () => {
    setVendorId("");
    setPaymentDate(today());
    setMethod("bank");
    setReference("");
    setNotes("");
    setAllocations({});
  };

  const recordPaymentAction = useIdempotentAction(async () => {
    if (!vendorId) {
      toast({ title: "Select a vendor", variant: "destructive" });
      return;
    }
    const rows = Object.entries(allocations)
      .map(([billId, amount]) => ({ billId, amount }))
      .filter((r) => r.amount > 0);
    const amountTotal = rows.reduce((s, r) => s + r.amount, 0);

    const result = await createPayment({
      vendorId,
      paymentDate,
      method,
      reference: reference || undefined,
      notes: notes || undefined,
      createdBy: user?.name,
      amount: amountTotal,
      allocations: rows,
    });
    if (result.ok === false) {
      toast({ title: result.error, variant: "destructive" });
      return result;
    }
    toast({ title: `${result.payment.paymentNumber} recorded` });
    setDialogOpen(false);
    resetForm();
    return { ok: true };
  });

  const voidPaymentAction = useIdempotentAction(async () => {
    if (!pendingVoid) return;
    const res = await voidPayment(pendingVoid.id, voidReason, user?.name || user?.email);
    if (res.ok === false) {
      toast({ title: res.error, variant: "destructive" });
      return res;
    }
    toast({ title: `${pendingVoid.paymentNumber} voided` });
    setPendingVoid(null);
    setVoidReason("");
    return { ok: true };
  });

  const activePayments = payments.filter((p) => p.status !== "Voided");
  const totalPaid = activePayments.reduce((s, p) => s + p.amount, 0);
  const totalDue = bills
    .filter((b) => b.status !== "Cancelled" && b.status !== "Draft")
    .reduce((s, b) => s + billBalance(b), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Wallet className="h-7 w-7" />
            {t("pages.purchases.paymentsMade.title", "Payments Made")}
          </h1>
          <p className="text-muted-foreground">
            {t("pages.purchases.paymentsMade.description", "Record vendor payments and allocate them across open bills.")}
          </p>
        </div>
        {can("purchases", "create") && (
          <Button onClick={() => setDialogOpen(true)} disabled={vendorsWithBills.length === 0}>
            <Plus className="me-2 h-4 w-4" />
            Record Payment
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Payments</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{activePayments.length}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total paid</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalPaid, settings.currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Still due</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{formatMoney(totalDue, settings.currency)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Payments ({payments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {payments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              No payments yet. Create a vendor bill first, then record a payment against it.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Bills</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">Amount</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => {
                  const isVoided = p.status === "Voided";
                  return (
                    <TableRow key={p.id} className={isVoided ? "opacity-60" : undefined}>
                      <TableCell className="font-medium">{p.paymentNumber}</TableCell>
                      <TableCell>{p.paymentDate}</TableCell>
                      <TableCell>{p.vendorName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{p.method}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{p.reference || "—"}</TableCell>
                      <TableCell className="text-sm">{p.allocations.map((a) => a.billNumber).join(", ")}</TableCell>
                      <TableCell>
                        <Badge variant={isVoided ? "destructive" : "secondary"}>
                          {isVoided ? "Voided" : "Posted"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-end font-medium">{formatMoney(p.amount, settings.currency)}</TableCell>
                      <TableCell>
                        {!isVoided && can("purchases", "delete") && (
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
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              Allocate the payment across the vendor's open bills. Each allocation is capped at the bill's balance due.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Vendor *</Label>
                <Select value={vendorId} onValueChange={(v) => { setVendorId(v); setAllocations({}); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendorsWithBills.map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>
                        {v.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payment Date</Label>
                <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
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
                <Label>Reference</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Transfer / cheque #"
                  maxLength={60}
                />
              </div>
            </div>

            {vendorId &&
              (openBills.length === 0 ? (
                <div className="rounded-md border py-6 text-center text-muted-foreground text-sm">
                  This vendor has no open bills.
                </div>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Bill #</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead className="text-end">Balance</TableHead>
                        <TableHead className="w-36">Payment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openBills.map((bill) => {
                        const balance = billBalance(bill);
                        return (
                          <TableRow key={bill.id}>
                            <TableCell className="font-medium">{bill.billNumber}</TableCell>
                            <TableCell>{bill.dueDate}</TableCell>
                            <TableCell className="text-end">{formatMoney(balance, settings.currency)}</TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                min={0}
                                max={balance}
                                step="0.01"
                                aria-label={`Amount to pay on ${bill.billNumber}`}
                                value={allocations[bill.id] ?? ""}
                                onChange={(e) => {
                                  const raw = parseFloat(e.target.value);
                                  const val = Number.isFinite(raw) ? Math.min(balance, Math.max(0, raw)) : 0;
                                  setAllocations((prev) => ({ ...prev, [bill.id]: val }));
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

            <div className="flex justify-end text-sm font-semibold">
              Total payment: {formatMoney(totalAllocated, settings.currency)}
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={500} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" disabled={recordPaymentAction.isPending} onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <SubmitButton
              type="button"
              pending={recordPaymentAction.isPending}
              isSlow={recordPaymentAction.isSlow}
              onClick={() => void recordPaymentAction.run()}
              disabled={totalAllocated <= 0}
            >
              Record Payment
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingVoid} onOpenChange={voidPaymentAction.guardOpenChange((open) => !open && setPendingVoid(null))}>
        <DialogContent className="max-w-md" locked={voidPaymentAction.isPending}>
          <DialogHeader>
            <DialogTitle>Void {pendingVoid?.paymentNumber}</DialogTitle>
            <DialogDescription>
              Voiding reverses the vendor bill payment allocations while preserving the numbered payment record in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="void-pay-reason">Reason *</Label>
            <Textarea
              id="void-pay-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Cancelled transfer, duplicate payment"
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={voidPaymentAction.isPending} onClick={() => setPendingVoid(null)}>
              Cancel
            </Button>
            <SubmitButton
              type="button"
              variant="destructive"
              pending={voidPaymentAction.isPending}
              isSlow={voidPaymentAction.isSlow}
              onClick={() => void voidPaymentAction.run()}
              disabled={!voidReason.trim()}
            >
              Confirm Void
            </SubmitButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
