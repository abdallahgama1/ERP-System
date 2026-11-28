import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, ShieldCheck } from "lucide-react";
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
import { useIdempotentAction } from "@/hooks/useIdempotentSubmit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import { useToast } from "@/hooks/use-toast";

export interface ReturnableReceiptLine {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
  taxAmount?: number;
  lineTotal: number;
  returnedQuantity?: number;
  remainingReturnableQuantity?: number;
}

export interface ReturnableReceiptDto {
  id: string;
  invoiceNumber: string;
  currency?: string;
  totalAmount: number;
  lines: ReturnableReceiptLine[];
}

export interface CreatedPosReturnDto {
  id: string;
  returnNumber: string;
  originalInvoiceId: string;
  refundMethod: PosPaymentMethod;
  restockItems: boolean;
  reason: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

interface PosReturnDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receipt: ReturnableReceiptDto | null;
  terminalId: string;
  shiftId: string;
  currency: string;
  requireManagerPin?: boolean;
  onSuccess?: (posReturn: CreatedPosReturnDto) => void;
}

export function PosReturnDialog({
  open,
  onOpenChange,
  receipt,
  terminalId,
  shiftId,
  currency,
  requireManagerPin = true,
  onSuccess,
}: PosReturnDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [restockItems, setRestockItems] = useState(true);
  const [refundMethod, setRefundMethod] = useState<PosPaymentMethod>("cash");
  const [reason, setReason] = useState("");
  const [managerPin, setManagerPin] = useState("");

  const submitAction = useIdempotentAction(async () => {
    if (!receipt) return;
    const res = await apiRequest<{
      posReturn?: CreatedPosReturnDto;
      returnRecord?: CreatedPosReturnDto;
    }>("/api/pos/returns", {
      method: "POST",
      body: {
        originalInvoiceId: receipt.id,
        terminalId,
        shiftId,
        refundMethod,
        restockItems,
        reason: reason.trim(),
        ...(managerPin.trim() ? { managerOverridePin: managerPin.trim() } : {}),
        lines: selectedLines.map(({ line, qty }) => ({
          originalInvoiceLineId: line.id,
          productId: line.productId!,
          quantity: qty,
        })),
      },
    });
    const created = res.posReturn ?? res.returnRecord;
    if (created) {
      toast({
        title: `${t("pos.returnProcessed", "Return processed")}: ${created.returnNumber}`,
        description: `${t("pos.refunded", "Refunded")} ${fmt(created.totalAmount)}`,
      });
      onSuccess?.(created);
    }
    onOpenChange(false);
  });
  const submitting = submitAction.isPending;
  const resetSubmitKey = submitAction.resetKey;

  useEffect(() => {
    if (receipt && open) {
      const next: Record<string, string> = {};
      receipt.lines.forEach((line, index) => {
        const remaining =
          line.remainingReturnableQuantity !== undefined
            ? line.remainingReturnableQuantity
            : Math.max(0, line.quantity - (line.returnedQuantity ?? 0));
        next[line.id] = index === 0 && remaining > 0 ? String(Math.min(1, remaining)) : "0";
      });
      setQuantities(next);
      setRestockItems(true);
      setRefundMethod("cash");
      setReason("");
      setManagerPin("");
      resetSubmitKey();
    }
  }, [open, receipt, resetSubmitKey]);

  if (!receipt) return null;

  const activeCurrency = receipt.currency || currency || "USD";
  const fmt = (n: number) => formatMoney(n, activeCurrency);

  const selectedLines = receipt.lines
    .map((line) => {
      const qty = Number(quantities[line.id] ?? 0);
      return {
        line,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      };
    })
    .filter((item) => item.qty > 0 && Boolean(item.line.productId));

  const estimatedRefund = selectedLines.reduce((sum, { line, qty }) => {
    const ratio = line.quantity > 0 ? qty / line.quantity : 0;
    return sum + line.lineTotal * ratio;
  }, 0);

  const handleSubmit = async () => {
    if (submitting) return;
    if (selectedLines.length === 0) {
      toast({
        title: t("pos.returnNoLines", "Select at least one item quantity to return"),
        variant: "destructive",
      });
      return;
    }
    if (!reason.trim()) {
      toast({
        title: t("pos.returnReasonRequired", "Return reason is required"),
        variant: "destructive",
      });
      return;
    }

    try {
      await submitAction.run();
    } catch (err) {
      toast({
        title: err instanceof Error ? err.message : t("common.error", "Failed to process return"),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && submitting) return; onOpenChange(next); }}>
      <DialogContent locked={submitting} className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-primary" />
            {t("pos.returnDialogTitle", "Return / Refund")} — {receipt.invoiceNumber}
          </DialogTitle>
          <DialogDescription>
            {t(
              "pos.returnDialogDesc",
              "Enter quantities to return, choose refund method, and provide manager override PIN if required."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("pos.returnItems", "Receipt Line Items")}</Label>
            <div className="divide-y rounded-md border">
              {receipt.lines.map((line) => {
                const remaining =
                  line.remainingReturnableQuantity !== undefined
                    ? line.remainingReturnableQuantity
                    : Math.max(0, line.quantity - (line.returnedQuantity ?? 0));
                return (
                  <div key={line.id} className="p-2.5 flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{line.description}</div>
                      <div className="text-xs text-muted-foreground">
                        {t("pos.soldQty", "Sold")}: {line.quantity} · {t("pos.returnableQty", "Returnable")}:{" "}
                        {remaining} · {fmt(line.lineTotal)}
                      </div>
                    </div>
                    <div className="w-24">
                      <Input
                        type="number"
                        min={0}
                        max={remaining}
                        step="1"
                        disabled={remaining <= 0 || submitting}
                        aria-label={`Return quantity for ${line.description}`}
                        value={quantities[line.id] ?? "0"}
                        onChange={(e) =>
                          setQuantities((prev) => ({
                            ...prev,
                            [line.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("pos.refundMethod", "Refund Method")}</Label>
              <Select
                value={refundMethod}
                onValueChange={(v) => setRefundMethod(v as PosPaymentMethod)}
              >
                <SelectTrigger aria-label="Refund method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">{t("pos.cash", "Cash")}</SelectItem>
                  <SelectItem value="card">{t("pos.card", "Card")}</SelectItem>
                  <SelectItem value="mobile_wallet">{t("pos.wallet", "Mobile Wallet")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end pb-2">
              <label
                htmlFor="pos-return-restock"
                className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none"
              >
                <input
                  id="pos-return-restock"
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary"
                  checked={restockItems}
                  onChange={(e) => setRestockItems(e.target.checked)}
                />
                {t("pos.restockReturnedItems", "Restock returned items to inventory")}
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pos-return-reason">{t("common.reason", "Return Reason")}</Label>
            <Textarea
              id="pos-return-reason"
              aria-label="Return reason"
              placeholder={t("pos.returnReasonPlaceholder", "Reason for return (e.g. Damaged packaging)")}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pos-return-manager-pin" className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4 text-primary" />
              {requireManagerPin
                ? t("pos.managerPinRequired", "Manager Override PIN")
                : t("pos.managerPinOptional", "Manager Override PIN (optional)")}
            </Label>
            <Input
              id="pos-return-manager-pin"
              name="managerOverridePin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="Manager PIN"
              value={managerPin}
              onChange={(e) => setManagerPin(e.target.value.replace(/\D/g, ""))}
            />
          </div>

          <div className="rounded-md bg-muted/40 border p-3 flex items-center justify-between text-sm">
            <span className="font-medium">{t("pos.estimatedRefund", "Estimated Refund")}</span>
            <span className="font-bold text-base tabular-nums">{fmt(estimatedRefund)}</span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel", "Cancel")}
          </Button>
          <SubmitButton type="button" onClick={() => void handleSubmit()} pending={submitting}>
            {t("pos.processReturn", "Process Return")}
          </SubmitButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
