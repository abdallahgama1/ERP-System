import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Banknote, CreditCard, Plus, Smartphone, Trash2 } from "lucide-react";
import type { PosPaymentMethod } from "@erp/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney } from "@/lib/money";

export interface PosTenderDraft {
  id: string;
  method: PosPaymentMethod;
  amount: number;
  tenderedAmount: number;
  reference: string;
}

interface SplitTenderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grandTotal: number;
  currency: string;
  isSubmitting?: boolean;
  onConfirm: (tenders: Array<{ method: PosPaymentMethod; amount: number; tenderedAmount: number; reference: string }>) => Promise<void>;
}

const QUICK_DENOMS = [10, 20, 50, 100, 200, 500];

export function SplitTenderDialog({
  open,
  onOpenChange,
  grandTotal,
  currency,
  isSubmitting = false,
  onConfirm,
}: SplitTenderDialogProps) {
  const { t } = useTranslation();
  const [tenders, setTenders] = useState<PosTenderDraft[]>([]);

  useEffect(() => {
    if (open) {
      const rounded = Number(grandTotal.toFixed(2));
      setTenders([
        {
          id: "t-1",
          method: "cash",
          amount: rounded,
          tenderedAmount: rounded,
          reference: "",
        },
      ]);
    }
  }, [open, grandTotal]);

  const summary = useMemo(() => {
    const appliedTotal = tenders.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const remaining = Number((grandTotal - appliedTotal).toFixed(2));
    const changeDue = tenders.reduce((sum, item) => {
      if (item.method !== "cash") return sum;
      return sum + Math.max(0, (Number(item.tenderedAmount) || 0) - (Number(item.amount) || 0));
    }, 0);
    const canSubmit =
      tenders.length > 0 &&
      Math.abs(remaining) <= 0.01 &&
      tenders.every((item) => item.amount > 0 && (item.method !== "cash" || item.tenderedAmount + 0.005 >= item.amount));
    return { appliedTotal, remaining, changeDue, canSubmit };
  }, [grandTotal, tenders]);

  const updateTender = (id: string, patch: Partial<PosTenderDraft>) => {
    setTenders((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item, ...patch };
        if (next.method !== "cash") {
          next.tenderedAmount = next.amount;
        }
        return next;
      })
    );
  };

  const addSplitTender = (method: PosPaymentMethod) => {
    const remaining = Math.max(0, Number(summary.remaining.toFixed(2)));
    setTenders((prev) => [
      ...prev,
      {
        id: `t-${Date.now()}-${prev.length + 1}`,
        method,
        amount: remaining,
        tenderedAmount: remaining,
        reference: "",
      },
    ]);
  };

  const fmt = (n: number) => formatMoney(n, currency || "USD");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && isSubmitting) return; onOpenChange(next); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" locked={isSubmitting}>
        <DialogHeader>
          <DialogTitle>{t("pos.collectPayment", "Collect Payment")}</DialogTitle>
          <DialogDescription>
            {t("pos.totalDue", "Total due")}:{" "}
            <span className="font-bold text-foreground text-base">{fmt(grandTotal)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {tenders.map((tender, index) => (
            <div key={tender.id} className="rounded-lg border p-3 space-y-3 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-muted-foreground">
                  {t("pos.tenderLine", "Tender")} #{index + 1}
                </span>
                {tenders.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove tender"
                    onClick={() => setTenders((prev) => prev.filter((x) => x.id !== tender.id))}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>{t("pos.paymentMethod", "Method")}</Label>
                  <Select
                    value={tender.method}
                    onValueChange={(val) =>
                      updateTender(tender.id, { method: val as PosPaymentMethod })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Cash</SelectItem>
                      <SelectItem value="card">Card</SelectItem>
                      <SelectItem value="mobile_wallet">Mobile Wallet</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor={`tender-amt-${tender.id}`}>{t("pos.appliedAmount", "Applied Amount")}</Label>
                  <Input
                    id={`tender-amt-${tender.id}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={tender.amount}
                    onChange={(e) => {
                      const val = Math.max(0, Number(e.target.value) || 0);
                      updateTender(tender.id, {
                        amount: val,
                        tenderedAmount: tender.method === "cash" ? Math.max(tender.tenderedAmount, val) : val,
                      });
                    }}
                  />
                </div>
              </div>

              {tender.method === "cash" ? (
                <div className="space-y-2">
                  <Label htmlFor={`tender-cash-${tender.id}`}>{t("pos.cashReceived", "Cash Received")}</Label>
                  <Input
                    id={`tender-cash-${tender.id}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={tender.tenderedAmount}
                    onChange={(e) =>
                      updateTender(tender.id, { tenderedAmount: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => updateTender(tender.id, { tenderedAmount: tender.amount })}
                    >
                      {t("pos.exact", "Exact")}
                    </Button>
                    {QUICK_DENOMS.map((bill) => (
                      <Button
                        key={bill}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => updateTender(tender.id, { tenderedAmount: bill })}
                      >
                        {bill}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor={`tender-ref-${tender.id}`}>{t("common.reference", "Reference / Auth #")}</Label>
                  <Input
                    id={`tender-ref-${tender.id}`}
                    value={tender.reference}
                    onChange={(e) => updateTender(tender.id, { reference: e.target.value })}
                    placeholder="POS-AUTH-1234"
                  />
                </div>
              )}
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => addSplitTender("cash")}>
              <Banknote className="me-1.5 h-4 w-4" />
              <Plus className="me-1 h-3 w-3" />
              Cash
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => addSplitTender("card")}>
              <CreditCard className="me-1.5 h-4 w-4" />
              <Plus className="me-1 h-3 w-3" />
              Card
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => addSplitTender("mobile_wallet")}>
              <Smartphone className="me-1.5 h-4 w-4" />
              <Plus className="me-1 h-3 w-3" />
              Wallet
            </Button>
          </div>

          <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("pos.remainingBalance", "Remaining Balance")}</span>
              <span className={Math.abs(summary.remaining) > 0.01 ? "font-bold text-destructive" : "font-semibold"}>
                {fmt(summary.remaining)}
              </span>
            </div>
            <div className="flex justify-between text-base font-bold">
              <span>{t("pos.changeDue", "Change Due")}</span>
              <span className="text-primary">{fmt(summary.changeDue)}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common.cancel")}
          </Button>
          <SubmitButton
            type="button"
            pending={isSubmitting}
            disabled={!summary.canSubmit}
            onClick={() =>
              void onConfirm(
                tenders.map((item) => ({
                  method: item.method,
                  amount: Number(item.amount.toFixed(2)),
                  tenderedAmount: Number(item.tenderedAmount.toFixed(2)),
                  reference: item.reference.trim(),
                }))
              )
            }
          >
            {t("pos.completeSale", "Complete Sale")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
