import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Barcode, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLotsQuery, useSerialsQuery } from "@/hooks/queries/useTrackingQueries";
import type { Product } from "@/types";

export interface LotAllocationDraft {
  lotId?: string;
  lotNumber?: string;
  quantity: number;
}

interface TrackingLinePickerProps {
  product: Product | undefined;
  branchId?: string;
  quantity: number;
  allowExpired?: boolean;
  lotAllocations?: LotAllocationDraft[];
  serialNumbers?: string[];
  onChange: (patch: { lotAllocations?: LotAllocationDraft[]; serialNumbers?: string[] }) => void;
}

export function TrackingLinePicker({
  product,
  branchId,
  quantity,
  allowExpired = false,
  lotAllocations,
  serialNumbers,
  onChange,
}: TrackingLinePickerProps) {
  const { t } = useTranslation();
  const mode = product?.trackingMode ?? "none";
  const [manualLots, setManualLots] = useState(Boolean(lotAllocations && lotAllocations.length > 0));
  const [scanInput, setScanInput] = useState("");

  const lotsQuery = useLotsQuery(
    mode === "lot" ? branchId : undefined,
    mode === "lot" ? product?.productId : undefined
  );
  const serialsQuery = useSerialsQuery(
    mode === "serial" ? branchId : undefined,
    mode === "serial" ? "in_stock" : undefined
  );

  const availableLots = useMemo(() => {
    const raw = lotsQuery.data?.lots ?? [];
    return raw.filter((l) => l.qtyOnHand > 0 && (allowExpired || l.expiryStatus !== "expired"));
  }, [lotsQuery.data, allowExpired]);

  const availableSerials = useMemo(() => {
    if (!product) return [];
    return (serialsQuery.data?.serials ?? []).filter((s) => s.productId === product.productId);
  }, [serialsQuery.data, product]);

  if (!product || mode === "none") return null;

  if (mode === "lot") {
    const allocMap = new Map((lotAllocations ?? []).map((a) => [a.lotNumber ?? a.lotId ?? "", a.quantity]));
    const allocatedTotal = (lotAllocations ?? []).reduce((s, a) => s + a.quantity, 0);
    const totalEligibleQty = availableLots.reduce((s, l) => s + l.qtyOnHand, 0);

    const setLotQty = (lotId: string, lotNumber: string, nextQty: number) => {
      const cleaned = Math.max(0, nextQty);
      const others = (lotAllocations ?? []).filter((a) => a.lotNumber !== lotNumber && a.lotId !== lotId);
      const updated = cleaned > 0 ? [...others, { lotId, lotNumber, quantity: cleaned }] : others;
      onChange({ lotAllocations: updated.length > 0 ? updated : undefined });
    };

    return (
      <div className="mt-2 rounded-md border bg-muted/30 p-2.5 space-y-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium">
            <Layers className="h-3.5 w-3.5 text-primary" />
            <span>
              {t("tracking.picker.lotTitle", "Lot Allocation")} ({product.pickingStrategy ?? "FEFO"})
            </span>
            <Badge variant="outline" className="text-[10px]">
              {t("tracking.picker.eligibleQty", "Eligible")}: {totalEligibleQty}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              if (manualLots) {
                setManualLots(false);
                onChange({ lotAllocations: undefined });
              } else {
                setManualLots(true);
              }
            }}
          >
            {manualLots
              ? t("tracking.picker.useAutoFefo", "Use Auto-Pick")
              : t("tracking.picker.pickManually", "Pick Lots Manually")}
          </Button>
        </div>

        {!manualLots ? (
          <p className="text-muted-foreground">
            {t(
              "tracking.picker.autoPickHint",
              "Server will auto-pick non-expired lots using {{strategy}}.",
              { strategy: product.pickingStrategy ?? "FEFO" }
            )}
          </p>
        ) : availableLots.length === 0 ? (
          <p className="text-destructive">
            {t("tracking.picker.noEligibleLots", "No eligible lots available at this branch.")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {availableLots.map((lot) => {
              const current = allocMap.get(lot.lotNumber) ?? allocMap.get(lot.lotId) ?? 0;
              return (
                <div key={lot.id} className="flex items-center justify-between gap-2 bg-background rounded px-2 py-1 border">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono font-medium">{lot.lotNumber}</span>
                    {lot.expiryDate && (
                      <Badge
                        variant={
                          lot.expiryStatus === "expired"
                            ? "destructive"
                            : lot.expiryStatus === "expiring_soon"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {lot.expiryDate.slice(0, 10)}
                      </Badge>
                    )}
                    <span className="text-muted-foreground">({lot.qtyOnHand} avail)</span>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={lot.qtyOnHand}
                    step="0.01"
                    className="h-7 w-20 text-xs"
                    value={current || ""}
                    placeholder="0"
                    onChange={(e) => setLotQty(lot.lotId, lot.lotNumber, Math.min(lot.qtyOnHand, Number(e.target.value) || 0))}
                  />
                </div>
              );
            })}
            <div className="flex justify-end">
              <Badge variant={Math.abs(allocatedTotal - quantity) < 0.001 ? "default" : "destructive"}>
                {t("tracking.picker.allocated", "Allocated")}: {allocatedTotal} / {quantity}
              </Badge>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Serial mode
  const selected = serialNumbers ?? [];
  const selectedSet = new Set(selected);

  const toggleSerial = (sn: string) => {
    const clean = sn.trim();
    if (!clean) return;
    const next = selectedSet.has(clean) ? selected.filter((s) => s !== clean) : [...selected, clean];
    onChange({ serialNumbers: next.length > 0 ? next : undefined });
  };

  const handleScanEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const val = scanInput.trim();
    if (!val) return;
    if (!selectedSet.has(val)) {
      onChange({ serialNumbers: [...selected, val] });
    }
    setScanInput("");
  };

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-2.5 space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium">
          <Barcode className="h-3.5 w-3.5 text-primary" />
          <span>{t("tracking.picker.serialTitle", "Serial Selection")}</span>
        </div>
        <Badge variant={selected.length === quantity ? "default" : "destructive"}>
          {selected.length} / {quantity} {t("tracking.picker.selected", "selected")}
        </Badge>
      </div>

      <Input
        value={scanInput}
        onChange={(e) => setScanInput(e.target.value)}
        onKeyDown={handleScanEnter}
        placeholder={t("tracking.picker.scanSerialPlaceholder", "Scan or type serial # and press Enter...")}
        className="h-7 text-xs font-mono"
      />

      {availableSerials.length === 0 ? (
        <p className="text-muted-foreground">
          {t("tracking.picker.noSerialsInBranch", "No in-stock serial numbers found at this branch.")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
          {availableSerials.map((s) => {
            const active = selectedSet.has(s.serialNumber);
            return (
              <Badge
                key={s.id}
                variant={active ? "default" : "outline"}
                className="cursor-pointer font-mono text-[11px]"
                onClick={() => toggleSerial(s.serialNumber)}
              >
                {s.serialNumber}
              </Badge>
            );
          })}
        </div>
      )}
    </div>
  );
}
