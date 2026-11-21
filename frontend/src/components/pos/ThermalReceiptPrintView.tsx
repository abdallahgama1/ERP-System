import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, CloudOff, Printer, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import type { PosReceiptPreview } from "@/lib/pos/posDb";
import { defaultThermalPrinter, type ThermalPaperWidth } from "@/lib/pos/thermalPrint";

interface ThermalReceiptPrintViewProps {
  receipt: PosReceiptPreview | null;
  companyName: string;
  taxNumber?: string;
  receiptHeader?: string;
  receiptFooter?: string;
  defaultPaperWidth?: ThermalPaperWidth;
  onClose: () => void;
}

export function ThermalReceiptPrintView({
  receipt,
  companyName,
  taxNumber,
  receiptHeader,
  receiptFooter,
  defaultPaperWidth = 80,
  onClose,
}: ThermalReceiptPrintViewProps) {
  const { t } = useTranslation();
  const [paperWidth, setPaperWidth] = useState<ThermalPaperWidth>(defaultPaperWidth);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    setPaperWidth(defaultPaperWidth);
  }, [defaultPaperWidth]);

  useEffect(() => {
    let active = true;
    const qrPayload = receipt?.qrTlv;
    if (!qrPayload) {
      setQrDataUrl(null);
      return;
    }
    void import("qrcode")
      .then((QRCode) => QRCode.toDataURL(qrPayload, { width: 150, margin: 1 }))
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [receipt]);

  if (!receipt) return null;

  const isOffline = receipt.syncStatus === "offline_pending";
  const fmt = (n: number) => formatMoney(n, receipt.currency || "USD");

  return (
    <Dialog open={Boolean(receipt)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span>{t("pos.receiptTitle", "Receipt")} {receipt.invoiceNumber}</span>
            <Badge variant={isOffline ? "secondary" : "default"} className="gap-1">
              {isOffline ? (
                <>
                  <CloudOff className="h-3 w-3" />
                  {t("pos.offlinePending", "Queued Offline")}
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  {t("pos.synced", "Synced")}
                </>
              )}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-center gap-2 pb-1">
          <Button
            type="button"
            size="sm"
            variant={paperWidth === 80 ? "default" : "outline"}
            onClick={() => setPaperWidth(80)}
          >
            80mm
          </Button>
          <Button
            type="button"
            size="sm"
            variant={paperWidth === 58 ? "default" : "outline"}
            onClick={() => setPaperWidth(58)}
          >
            58mm
          </Button>
        </div>

        {/* Printable Thermal Receipt Surface */}
        <div
          id="pos-thermal-receipt"
          className={`mx-auto rounded border bg-white text-black p-4 font-mono text-xs leading-relaxed shadow-sm ${
            paperWidth === 58 ? "w-[235px]" : "w-[310px]"
          }`}
        >
          <div className="text-center space-y-0.5 border-b border-dashed border-black/40 pb-2">
            <div className="font-bold text-sm">{companyName}</div>
            {receiptHeader && <div className="text-[11px]">{receiptHeader}</div>}
            {taxNumber && <div>TRN / VAT: {taxNumber}</div>}
            <div className="pt-1 font-semibold">{receipt.invoiceNumber}</div>
            <div>{new Date(receipt.invoiceDate).toLocaleString()}</div>
            <div>
              {t("pos.cashier", "Cashier")}: {receipt.cashierName}
            </div>
            <div>
              {t("invoices.customer", "Customer")}: {receipt.customerName}
            </div>
          </div>

          <div className="py-2 border-b border-dashed border-black/40 space-y-1.5">
            {receipt.lines.map((line, idx) => (
              <div key={`${line.productId ?? idx}-${idx}`}>
                <div className="font-medium truncate">{line.description}</div>
                <div className="flex justify-between tabular-nums">
                  <span>
                    {line.quantity} x {fmt(line.unitPrice)}
                    {line.discount > 0 ? ` (-${fmt(line.discount)})` : ""}
                  </span>
                  <span>{fmt(line.lineTotal)}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="py-2 border-b border-dashed border-black/40 space-y-0.5 tabular-nums">
            <div className="flex justify-between">
              <span>{t("invoices.subtotal", "Subtotal")}</span>
              <span>{fmt(receipt.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("invoices.totalTax", "VAT / Tax")}</span>
              <span>{fmt(receipt.taxTotal)}</span>
            </div>
            <div className="flex justify-between font-bold text-sm pt-1">
              <span>{t("pos.total", "TOTAL")}</span>
              <span>{fmt(receipt.totalAmount)}</span>
            </div>
          </div>

          <div className="py-2 border-b border-dashed border-black/40 space-y-0.5 tabular-nums">
            {receipt.tenders.map((tender, idx) => (
              <div key={`${tender.method}-${idx}`} className="flex justify-between">
                <span className="capitalize">
                  {tender.method.replace("_", " ")}
                  {tender.reference ? ` (${tender.reference})` : ""}
                </span>
                <span>{fmt(tender.tenderedAmount)}</span>
              </div>
            ))}
            {receipt.totalChangeGiven > 0.005 && (
              <div className="flex justify-between font-bold pt-0.5">
                <span>{t("pos.changeDue", "Change")}</span>
                <span>{fmt(receipt.totalChangeGiven)}</span>
              </div>
            )}
          </div>

          {qrDataUrl && (
            <div className="pt-3 flex flex-col items-center gap-1">
              <img src={qrDataUrl} alt="Tax QR Code" className="h-28 w-28" />
              {receipt.etaDocumentUuid && (
                <div className="text-[9px] text-center break-all opacity-75">
                  ETA UUID: {receipt.etaDocumentUuid.slice(0, 24)}...
                </div>
              )}
              {receipt.icv && <div className="text-[10px]">ICV #{receipt.icv}</div>}
            </div>
          )}

          {isOffline && (
            <div className="mt-2 text-center text-[10px] font-semibold">
              * OFFLINE RECEIPT — PENDING TAX &amp; LEDGER SYNC *
            </div>
          )}

          <div className="pt-2 text-center text-[11px]">
            {receiptFooter || t("pos.thankYou", "Thank you for your business!")}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={onClose} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            {t("pos.newSale", "New Sale")}
          </Button>
          <Button
            onClick={() => void defaultThermalPrinter.printReceipt(receipt, paperWidth)}
            className="gap-2"
          >
            <Printer className="h-4 w-4" />
            {t("pos.printReceipt", "Print Receipt")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
