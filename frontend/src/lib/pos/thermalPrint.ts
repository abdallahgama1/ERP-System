import type { PosReceiptPreview } from "./posDb";

export type ThermalPaperWidth = 58 | 80;

export interface ThermalPrintAdapter {
  readonly name: string;
  printReceipt(receipt: PosReceiptPreview, paperWidthMm: ThermalPaperWidth): Promise<void>;
}

/**
 * Default browser-native thermal receipt print adapter using CSS @media print rules
 * for 80mm and 58mm roll widths. Can be swapped for WebUSB/WebSerial/ESC-POS adapters later.
 */
export class BrowserPrintAdapter implements ThermalPrintAdapter {
  readonly name = "browser-print";

  async printReceipt(_receipt: PosReceiptPreview, paperWidthMm: ThermalPaperWidth = 80): Promise<void> {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const widthClass = paperWidthMm === 58 ? "pos-paper-58mm" : "pos-paper-80mm";
    document.body.classList.add("pos-printing", widthClass);
    try {
      window.print();
    } finally {
      setTimeout(() => {
        document.body.classList.remove("pos-printing", "pos-paper-58mm", "pos-paper-80mm");
      }, 300);
    }
  }
}

export const defaultThermalPrinter: ThermalPrintAdapter = new BrowserPrintAdapter();
