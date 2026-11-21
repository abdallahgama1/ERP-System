import { useEffect, useRef, useState } from "react";

export interface BarcodeMatchable {
  barcode?: string | null;
  product_sku?: string;
  sku?: string;
}

/**
 * Cleans raw keyboard-wedge scanner buffer without stripping valid EAN/UPC/Code128 characters.
 */
export function sanitizeScannedCode(raw: string): string {
  return raw
    .replace(/Enter/g, "")
    .replace(/[\r\n\t]/g, "")
    .trim();
}

/**
 * Matches an exact scanned code against product.barcode first, then product_sku/sku (case-insensitive).
 */
export function matchProductByScanCode<T extends BarcodeMatchable>(
  items: T[],
  rawCode: string
): T | undefined {
  const normalized = sanitizeScannedCode(rawCode).toUpperCase();
  if (!normalized) return undefined;

  const byBarcode = items.find(
    (item) => Boolean(item.barcode) && item.barcode!.trim().toUpperCase() === normalized
  );
  if (byBarcode) return byBarcode;

  return items.find((item) => {
    const sku = item.product_sku ?? item.sku ?? "";
    return sku.trim().toUpperCase() === normalized;
  });
}

export interface UseBarcodeScannerOptions {
  enabled?: boolean;
  scanTimeoutMs?: number;
  ignoreInputIds?: string[];
  ignoreAllInputs?: boolean;
  onScan: (code: string) => void;
}

export function useBarcodeScanner({
  enabled = true,
  scanTimeoutMs = 100,
  ignoreInputIds = [],
  ignoreAllInputs = false,
  onScan,
}: UseBarcodeScannerOptions): { isScanning: boolean } {
  const [isScanning, setIsScanning] = useState(false);
  const bufferRef = useRef("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;

    const flush = () => {
      const code = sanitizeScannedCode(bufferRef.current);
      bufferRef.current = "";
      setIsScanning(false);
      if (code.length > 0) {
        onScanRef.current(code);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const target = event.target as HTMLElement | null;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if (isEditable) {
        if (ignoreAllInputs) return;
        if (target?.id && ignoreInputIds.includes(target.id)) return;
      }

      if (event.key === "Enter") {
        if (bufferRef.current.length > 0) {
          event.preventDefault();
          if (timerRef.current) clearTimeout(timerRef.current);
          flush();
        }
        return;
      }

      if (event.key.length === 1) {
        setIsScanning(true);
        bufferRef.current += event.key;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, scanTimeoutMs);
      } else {
        setIsScanning(false);
        bufferRef.current = "";
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [enabled, ignoreAllInputs, ignoreInputIds, scanTimeoutMs]);

  return { isScanning };
}
