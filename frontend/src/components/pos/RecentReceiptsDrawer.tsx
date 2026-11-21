import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Printer, RotateCcw, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import type { PosReceiptPreview } from "@/lib/pos/posDb";
import type { ReturnableReceiptDto, ReturnableReceiptLine } from "./PosReturnDialog";

export interface PosReceiptListItemDto extends Omit<PosReceiptPreview, "lines"> {
  returnCount?: number;
  returnedTotalAmount?: number;
  remainingReturnableQty?: number;
  lines: ReturnableReceiptLine[];
}

interface RecentReceiptsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  terminalId?: string;
  currency: string;
  onReprint: (receipt: PosReceiptPreview) => void;
  onStartReturn: (receipt: ReturnableReceiptDto) => void;
}

export function RecentReceiptsDrawer({
  open,
  onOpenChange,
  terminalId,
  currency,
  onReprint,
  onStartReturn,
}: RecentReceiptsDrawerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [receipts, setReceipts] = useState<PosReceiptListItemDto[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<PosReceiptListItemDto | null>(null);
  const [loading, setLoading] = useState(false);

  const fmt = useCallback(
    (n: number, curr?: string) => formatMoney(n, curr || currency || "USD"),
    [currency]
  );

  const loadReceipts = useCallback(
    async (qText: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (terminalId) params.set("terminalId", terminalId);
        if (qText.trim()) params.set("q", qText.trim());
        params.set("pageSize", "30");
        const res = await apiRequest<{
          items?: PosReceiptListItemDto[];
          receipts?: PosReceiptListItemDto[];
        }>(`/api/pos/receipts?${params.toString()}`);
        const list = res.receipts ?? res.items ?? [];
        setReceipts(list);
        setSelectedReceipt((prev) => {
          if (prev) {
            const updated = list.find((r) => r.id === prev.id);
            if (updated) return updated;
          }
          return list[0] ?? null;
        });
      } catch {
        setReceipts([]);
      } finally {
        setLoading(false);
      }
    },
    [terminalId]
  );

  useEffect(() => {
    if (!open) return;
    void loadReceipts(search);
  }, [loadReceipts, open, search]);

  const handleSelectReceipt = async (item: PosReceiptListItemDto) => {
    setSelectedReceipt(item);
    try {
      const detailRes = await apiRequest<{ receipt: PosReceiptListItemDto }>(
        `/api/pos/receipts/${item.id}`
      );
      if (detailRes.receipt) {
        setSelectedReceipt(detailRes.receipt);
      }
    } catch {
      // keep optimistic item from list
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            {t("pos.recentReceipts", "Recent POS Receipts")}
          </DialogTitle>
          <DialogDescription>
            {t("pos.recentReceiptsDesc", "Search receipts by POS number or customer, reprint, or process a return.")}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search receipt POS-..."
            aria-label="Search receipts"
            className="ps-9"
          />
        </div>

        <div className="grid md:grid-cols-12 gap-4 flex-1 min-h-[340px] overflow-hidden">
          {/* Receipt list */}
          <div className="md:col-span-5 border rounded-lg overflow-y-auto divide-y max-h-[52vh]">
            {loading && receipts.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("common.loading", "Loading receipts...")}
              </div>
            ) : receipts.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("pos.noReceiptsFound", "No POS receipts found")}
              </div>
            ) : (
              receipts.map((item) => {
                const isSelected = selectedReceipt?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleSelectReceipt(item)}
                    className={`w-full text-start p-3 transition-colors hover:bg-muted/60 ${
                      isSelected ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{item.invoiceNumber}</span>
                      <span className="font-semibold text-sm tabular-nums">
                        {fmt(item.totalAmount, item.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mt-1">
                      <span className="truncate">{item.customerName}</span>
                      <span>{new Date(item.invoiceDate).toLocaleTimeString()}</span>
                    </div>
                    {(item.returnCount ?? 0) > 0 && (
                      <div className="mt-1">
                        <Badge variant="secondary" className="text-[10px]">
                          {t("pos.returnedBadge", "Returned")} ({item.returnCount})
                        </Badge>
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Selected receipt detail + actions */}
          <div className="md:col-span-7 border rounded-lg p-4 flex flex-col justify-between max-h-[52vh] overflow-y-auto">
            {!selectedReceipt ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                {t("pos.selectReceiptToInspect", "Select a receipt to inspect or return")}
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <div className="flex items-start justify-between border-b pb-2">
                    <div>
                      <div className="font-mono font-bold text-base">
                        {selectedReceipt.invoiceNumber}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {selectedReceipt.customerName} ·{" "}
                        {new Date(selectedReceipt.invoiceDate).toLocaleString()}
                      </div>
                    </div>
                    <Badge variant="outline">{selectedReceipt.cashierName}</Badge>
                  </div>

                  <div className="divide-y text-sm">
                    {selectedReceipt.lines.map((line, idx) => (
                      <div
                        key={line.id || `${line.productId ?? idx}-${idx}`}
                        className="py-2 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{line.description}</div>
                          <div className="text-xs text-muted-foreground">
                            {line.quantity} × {fmt(line.unitPrice, selectedReceipt.currency)}
                            {(line.returnedQuantity ?? 0) > 0
                              ? ` · Returned: ${line.returnedQuantity}`
                              : ""}
                          </div>
                        </div>
                        <div className="font-semibold tabular-nums">
                          {fmt(line.lineTotal, selectedReceipt.currency)}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="border-t pt-2 space-y-1 text-sm tabular-nums">
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t("invoices.subtotal", "Subtotal")}</span>
                      <span>{fmt(selectedReceipt.subtotal, selectedReceipt.currency)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>{t("invoices.totalTax", "VAT / Tax")}</span>
                      <span>{fmt(selectedReceipt.taxTotal, selectedReceipt.currency)}</span>
                    </div>
                    <div className="flex justify-between font-bold text-base pt-1">
                      <span>{t("pos.total", "Total")}</span>
                      <span>{fmt(selectedReceipt.totalAmount, selectedReceipt.currency)}</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 pt-4 border-t mt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      onOpenChange(false);
                      onReprint(selectedReceipt as unknown as PosReceiptPreview);
                    }}
                    className="gap-1.5"
                  >
                    <Printer className="h-4 w-4" />
                    {t("pos.reprint", "Reprint")}
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => {
                      onOpenChange(false);
                      onStartReturn(selectedReceipt);
                    }}
                    className="gap-1.5"
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t("pos.returnRefund", "Return / Refund")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
