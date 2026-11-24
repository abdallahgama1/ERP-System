import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Plus, Send, Trash2, Ban } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { useSalesScope } from "@/hooks/queries/useSalesScope";
import { useAuth } from "@/contexts/AuthContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useSettings } from "@/contexts/SettingsContext";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";
import type { RetainerInvoice, RetainerStatus } from "@/types";

const today = () => new Date().toISOString().split("T")[0];

const STATUS_VARIANT: Record<RetainerStatus, "secondary" | "default" | "outline" | "destructive"> = {
  Draft: "secondary",
  Sent: "outline",
  Paid: "default",
  "Partially Applied": "outline",
  Applied: "default",
  Cancelled: "destructive",
};

export default function RetainerInvoices() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const money = (n: number) => formatMoney(n, settings.currency);
  const {
    customers, invoices, retainers, retainerAvailable, createRetainer, sendRetainer,
    recordRetainerPayment, applyRetainerToInvoice, cancelRetainer, deleteRetainer, invoiceBalance,
  } = useSalesScope({ customers: true, invoices: true, retainers: true });
  const { user } = useAuth();
  const { can } = usePermissions();
  const canCreate = can("sales", "create");
  const canEdit = can("sales", "edit");
  const canDelete = can("sales", "delete");
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [retainerDate, setRetainerDate] = useState(today());
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const [payFor, setPayFor] = useState<RetainerInvoice | null>(null);
  const [payAmount, setPayAmount] = useState("");

  const [applyFor, setApplyFor] = useState<RetainerInvoice | null>(null);
  const [applyInvoiceId, setApplyInvoiceId] = useState("");
  const [applyAmount, setApplyAmount] = useState("");

  const [pendingDelete, setPendingDelete] = useState<RetainerInvoice | null>(null);

  const resetForm = () => { setCustomerId(""); setRetainerDate(today()); setAmount(""); setNotes(""); };

  const submit = async () => {
    const res = await createRetainer({
      customerId,
      retainerDate,
      amount: parseFloat(amount) || 0,
      notes: notes || undefined,
      createdBy: user?.name,
    });
    if (res.ok === false) return toast({ title: res.error, variant: "destructive" });
    toast({ title: `${res.retainer.retainerNumber} ${t("sales.retainers.created", "created")}` });
    setOpen(false);
    resetForm();
  };

  const guard = async (promise: Promise<{ ok: true } | { ok: false; error: string }>, message: string) => {
    const res = await promise;
    if (res.ok === false) return toast({ title: res.error, variant: "destructive" });
    toast({ title: message });
  };

  const applyTargets = useMemo(
    () => (applyFor ? invoices.filter(i => i.customerId === applyFor.customerId && i.status !== "Draft" && i.status !== "Cancelled" && invoiceBalance(i) > 0) : []),
    [applyFor, invoices, invoiceBalance],
  );

  const totalInvoiced = retainers.filter(r => r.status !== "Cancelled").reduce((s, r) => s + r.amount, 0);
  const totalPaid = retainers.filter(r => r.status !== "Cancelled").reduce((s, r) => s + r.amountPaid, 0);
  const totalAvailable = retainers.filter(r => r.status !== "Cancelled").reduce((s, r) => s + retainerAvailable(r), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t("sales.retainers.title", "Retainer Invoices")}</h1>
          <p className="text-muted-foreground">
            {t("sales.retainers.subtitle", "Invoice money up front and draw it down against later invoices.")}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 me-2" />
            {t("sales.retainers.new", "New Retainer")}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.retainers.invoiced", "Invoiced")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{money(totalInvoiced)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.retainers.paid", "Paid")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{money(totalPaid)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{t("sales.retainers.available", "Available to apply")}</CardTitle></CardHeader>
          <CardContent className="text-2xl font-bold">{money(totalAvailable)}</CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          {retainers.length === 0 ? (
            <div className="p-12 text-center space-y-3">
              <FileText className="h-10 w-10 mx-auto text-muted-foreground" />
              <p className="text-muted-foreground">
                {t("sales.retainers.empty", "No retainers yet. Create one to take an advance from a customer.")}
              </p>
              {canCreate && (
                <Button onClick={() => setOpen(true)}>{t("sales.retainers.new", "New Retainer")}</Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("sales.retainers.number", "Retainer #")}</TableHead>
                  <TableHead>{t("common.date", "Date")}</TableHead>
                  <TableHead>{t("sales.customer", "Customer")}</TableHead>
                  <TableHead className="text-end">{t("common.amount", "Amount")}</TableHead>
                  <TableHead className="text-end">{t("sales.retainers.paid", "Paid")}</TableHead>
                  <TableHead className="text-end">{t("sales.retainers.applied", "Applied")}</TableHead>
                  <TableHead className="text-end">{t("sales.retainers.available", "Available")}</TableHead>
                  <TableHead>{t("common.status", "Status")}</TableHead>
                  <TableHead className="text-end">{t("common.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {retainers.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.retainerNumber}</TableCell>
                    <TableCell>{r.retainerDate}</TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell className="text-end">{money(r.amount)}</TableCell>
                    <TableCell className="text-end">{money(r.amountPaid)}</TableCell>
                    <TableCell className="text-end">{money(r.amountApplied)}</TableCell>
                    <TableCell className="text-end">{money(retainerAvailable(r))}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[r.status]}>
                        {t(`sales.retainers.statuses.${r.status}`, r.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1 flex-wrap">
                        {canEdit && r.status === "Draft" && (
                          <Button variant="outline" size="sm" onClick={() => guard(sendRetainer(r.id), t("sales.retainers.sent", "Retainer sent"))}>
                            <Send className="h-3.5 w-3.5 me-1" />{t("sales.retainers.send", "Send")}
                          </Button>
                        )}
                        {canEdit && r.status !== "Draft" && r.status !== "Cancelled" && r.amountPaid < r.amount - 0.005 && (
                          <Button variant="outline" size="sm" onClick={() => { setPayFor(r); setPayAmount((r.amount - r.amountPaid).toFixed(2)); }}>
                            {t("sales.retainers.recordPayment", "Record payment")}
                          </Button>
                        )}
                        {canEdit && retainerAvailable(r) > 0 && (
                          <Button variant="outline" size="sm" onClick={() => { setApplyFor(r); setApplyAmount(retainerAvailable(r).toFixed(2)); }}>
                            {t("sales.retainers.apply", "Apply")}
                          </Button>
                        )}
                        {canEdit && r.status !== "Cancelled" && r.amountPaid === 0 && r.amountApplied === 0 && (
                          <Button variant="ghost" size="sm" onClick={() => guard(cancelRetainer(r.id), t("sales.retainers.cancelled", "Retainer cancelled"))}>
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canDelete && r.status === "Draft" && r.amountPaid === 0 && r.amountApplied === 0 && (
                          <Button variant="ghost" size="sm" onClick={() => setPendingDelete(r)}>
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
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

      <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sales.retainers.new", "New Retainer")}</DialogTitle>
            <DialogDescription>
              {t("sales.retainers.dialogDesc", "An advance invoice with no stock lines — apply it to invoices later.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("sales.customer", "Customer")}</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger><SelectValue placeholder={t("sales.selectCustomer", "Select customer")} /></SelectTrigger>
                <SelectContent>
                  {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.displayName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("common.date", "Date")}</Label>
                <Input type="date" value={retainerDate} onChange={e => setRetainerDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.amount", "Amount")}</Label>
                <Input type="number" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("common.notes", "Notes")}</Label>
              <Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t("common.cancel", "Cancel")}</Button>
            <Button onClick={submit} disabled={!customerId || !(parseFloat(amount) > 0)}>{t("common.save", "Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payFor} onOpenChange={o => { if (!o) { setPayFor(null); setPayAmount(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sales.retainers.recordPayment", "Record payment")}</DialogTitle>
            <DialogDescription>{payFor?.retainerNumber}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{t("common.amount", "Amount")}</Label>
            <Input type="number" min={0} step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>{t("common.cancel", "Cancel")}</Button>
            <Button
              onClick={async () => {
                if (!payFor) return;
                const res = await recordRetainerPayment(payFor.id, parseFloat(payAmount) || 0);
                if (res.ok === false) return toast({ title: res.error, variant: "destructive" });
                toast({ title: t("sales.retainers.paymentRecorded", "Payment recorded") });
                setPayFor(null); setPayAmount("");
              }}
            >
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!applyFor} onOpenChange={o => { if (!o) { setApplyFor(null); setApplyInvoiceId(""); setApplyAmount(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sales.retainers.applyToInvoice", "Apply to invoice")}</DialogTitle>
            <DialogDescription>
              {applyFor ? `${applyFor.retainerNumber} — ${money(retainerAvailable(applyFor))}` : ""}
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
            <Button
              disabled={!applyInvoiceId}
              onClick={async () => {
                if (!applyFor) return;
                const res = await applyRetainerToInvoice(applyFor.id, applyInvoiceId, parseFloat(applyAmount) || 0);
                if (res.ok === false) return toast({ title: res.error, variant: "destructive" });
                toast({ title: t("sales.retainers.applied", "Applied") });
                setApplyFor(null); setApplyInvoiceId(""); setApplyAmount("");
              }}
            >
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={!!pendingDelete}
        onOpenChange={o => { if (!o) setPendingDelete(null); }}
        itemName={pendingDelete?.retainerNumber ?? ""}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const res = await deleteRetainer(pendingDelete.id);
          if (res.ok === false) {
            toast({ title: res.error, variant: "destructive" });
          } else {
            toast({ title: `${pendingDelete.retainerNumber} ${t("common.deleted", "deleted")}` });
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
