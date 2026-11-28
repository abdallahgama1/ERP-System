import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownCircle, ArrowUpCircle, Calculator, Lock } from "lucide-react";
import type { PosCashMovementType } from "@erp/shared";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney } from "@/lib/money";

export interface PosShiftDto {
  id: string;
  shiftNumber: string;
  terminalId: string;
  branchId: string;
  status: "open" | "closed";
  openingFloat: number;
  expectedCash: number;
  countedCash: number | null;
  cashVariance: number | null;
  totalCashSales: number;
  totalCardSales: number;
  totalWalletSales: number;
  totalSalesCount: number;
  totalCashRefunds?: number;
  totalCardRefunds?: number;
  totalWalletRefunds?: number;
  totalRefundsCount?: number;
  notes: string;
  openedAt: string;
  closedAt: string | null;
}

interface ShiftReconciliationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeShift: PosShiftDto | null;
  currency: string;
  onOpenShift: (openingFloat: number, notes: string) => Promise<void>;
  onCashMovement: (movementType: PosCashMovementType, amount: number, reason: string) => Promise<void>;
  onCloseShift: (countedCash: number, notes: string) => Promise<void>;
}

export function ShiftReconciliationDialog({
  open,
  onOpenChange,
  activeShift,
  currency,
  onOpenShift,
  onCashMovement,
  onCloseShift,
}: ShiftReconciliationDialogProps) {
  const { t } = useTranslation();
  const [openingFloat, setOpeningFloat] = useState("200");
  const [openNotes, setOpenNotes] = useState("");
  const [movementType, setMovementType] = useState<PosCashMovementType>("safe_drop");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");
  const [countedCash, setCountedCash] = useState("");
  const [closeNotes, setCloseNotes] = useState("");

  const openShiftAction = useIdempotentAction(async () => {
    await onOpenShift(Math.max(0, Number(openingFloat) || 0), openNotes.trim());
    setOpenNotes("");
    onOpenChange(false);
  });
  const closeShiftAction = useIdempotentAction(async () => {
    await onCloseShift(Math.max(0, Number(countedCash) || 0), closeNotes.trim());
    setCountedCash("");
    setCloseNotes("");
    onOpenChange(false);
  });
  const cashMovementAction = useIdempotentAction(async () => {
    await onCashMovement(movementType, Number(movementAmount), movementReason.trim());
    setMovementAmount("");
    setMovementReason("");
  });
  const busy = openShiftAction.isPending || closeShiftAction.isPending || cashMovementAction.isPending;

  const fmt = (n: number) => formatMoney(n, currency || "USD");
  const parsedCounted = Number(countedCash);
  const variance =
    activeShift && countedCash !== "" && Number.isFinite(parsedCounted)
      ? parsedCounted - activeShift.expectedCash
      : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && busy) return; onOpenChange(next); }}>
      <DialogContent locked={busy} className="max-w-lg">
        {!activeShift ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Calculator className="h-5 w-5 text-primary" />
                {t("pos.openShift", "Open Cashier Shift")}
              </DialogTitle>
              <DialogDescription>
                {t("pos.openShiftDesc", "Enter the starting cash drawer float before ringing up sales.")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pos-opening-float">{t("pos.openingFloat", "Opening Float")}</Label>
                <Input
                  id="pos-opening-float"
                  type="number"
                  min={0}
                  step="0.01"
                  value={openingFloat}
                  onChange={(e) => setOpeningFloat(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pos-open-notes">{t("common.notes", "Notes")}</Label>
                <Textarea
                  id="pos-open-notes"
                  rows={2}
                  value={openNotes}
                  onChange={(e) => setOpenNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <SubmitButton
                type="button"
                pending={openShiftAction.isPending}
                disabled={busy}
                onClick={() => void openShiftAction.run()}
              >
                {t("pos.startShift", "Open Shift")}
              </SubmitButton>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Calculator className="h-5 w-5 text-primary" />
                {t("pos.shiftDrawer", "Shift")} {activeShift.shiftNumber}
              </DialogTitle>
              <DialogDescription>
                {t("pos.salesCount", "Sales")}: {activeShift.totalSalesCount} ·{" "}
                {t("pos.expectedCash", "Expected Cash")}: {fmt(activeShift.expectedCash)}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-2 text-center rounded-lg border p-3 bg-muted/30 text-xs">
              <div>
                <div className="text-muted-foreground">{t("pos.cashSales", "Cash")}</div>
                <div className="font-bold text-sm">{fmt(activeShift.totalCashSales)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t("pos.cardSales", "Card")}</div>
                <div className="font-bold text-sm">{fmt(activeShift.totalCardSales)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">{t("pos.walletSales", "Wallet")}</div>
                <div className="font-bold text-sm">{fmt(activeShift.totalWalletSales)}</div>
              </div>
            </div>

            <Tabs defaultValue="close" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="close">{t("pos.closeShift", "Close & Reconcile")}</TabsTrigger>
                <TabsTrigger value="movement">{t("pos.cashMovement", "Pay In / Drop")}</TabsTrigger>
              </TabsList>

              <TabsContent value="close" className="space-y-4 pt-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pos-counted-cash">{t("pos.countedCash", "Counted Drawer Cash")}</Label>
                  <Input
                    id="pos-counted-cash"
                    type="number"
                    min={0}
                    step="0.01"
                    value={countedCash}
                    onChange={(e) => setCountedCash(e.target.value)}
                    placeholder={activeShift.expectedCash.toFixed(2)}
                  />
                </div>
                {variance !== null && (
                  <div className="rounded-md border p-2.5 text-sm flex justify-between">
                    <span>{t("pos.cashVariance", "Over / Short Variance")}</span>
                    <span
                      className={
                        Math.abs(variance) > 0.01
                          ? variance < 0
                            ? "font-bold text-destructive"
                            : "font-bold text-amber-600"
                          : "font-bold text-green-600"
                      }
                    >
                      {variance >= 0 ? "+" : ""}
                      {fmt(variance)}
                    </span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="pos-close-notes">{t("common.notes", "Closing Notes")}</Label>
                  <Textarea
                    id="pos-close-notes"
                    rows={2}
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                  />
                </div>
                <SubmitButton
                  type="button"
                  className="w-full gap-2"
                  variant="destructive"
                  pending={closeShiftAction.isPending}
                  disabled={busy || countedCash === ""}
                  onClick={() => void closeShiftAction.run()}
                >
                  <Lock className="h-4 w-4" />
                  {t("pos.confirmCloseShift", "Close Shift & Post Variance")}
                </SubmitButton>
              </TabsContent>

              <TabsContent value="movement" className="space-y-4 pt-3">
                <div className="space-y-1.5">
                  <Label>{t("pos.movementType", "Movement Type")}</Label>
                  <Select value={movementType} onValueChange={(v) => setMovementType(v as PosCashMovementType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pay_in">Pay In (Add Float)</SelectItem>
                      <SelectItem value="pay_out">Pay Out (Petty Expense)</SelectItem>
                      <SelectItem value="safe_drop">Safe Drop</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pos-mov-amt">{t("common.amount", "Amount")}</Label>
                  <Input
                    id="pos-mov-amt"
                    type="number"
                    min={0.01}
                    step="0.01"
                    value={movementAmount}
                    onChange={(e) => setMovementAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pos-mov-reason">{t("common.reason", "Reason")}</Label>
                  <Input
                    id="pos-mov-reason"
                    value={movementReason}
                    onChange={(e) => setMovementReason(e.target.value)}
                    placeholder="Mid-day cash drop"
                  />
                </div>
                <SubmitButton
                  type="button"
                  className="w-full gap-2"
                  pending={cashMovementAction.isPending}
                  disabled={busy || !movementAmount || !movementReason.trim()}
                  onClick={() => void cashMovementAction.run()}
                >
                  {movementType === "pay_in" ? (
                    <ArrowDownCircle className="h-4 w-4" />
                  ) : (
                    <ArrowUpCircle className="h-4 w-4" />
                  )}
                  {t("pos.recordCashMovement", "Record Cash Movement")}
                </SubmitButton>
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
