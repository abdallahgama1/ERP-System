import { describe, expect, it } from "vitest";
import { matchProductByScanCode, sanitizeScannedCode } from "@/hooks/useBarcodeScanner";

describe("useBarcodeScanner helpers", () => {
  const catalog = [
    { productId: "p1", product_sku: "SKU-001", barcode: "6221234567890" },
    { productId: "p2", product_sku: "SKU_SPECIAL.1/2", barcode: "EAN_88/99+A" },
    { productId: "p3", product_sku: "FALLBACK-SKU", barcode: null },
  ];

  it("preserves valid EAN/UPC/Code128 barcode characters while stripping control chars", () => {
    expect(sanitizeScannedCode("  EAN_88/99+AEnter\r\n")).toBe("EAN_88/99+A");
  });

  it("matches product.barcode first (case-insensitive) and falls back to product_sku", () => {
    expect(matchProductByScanCode(catalog, "6221234567890")?.productId).toBe("p1");
    expect(matchProductByScanCode(catalog, "ean_88/99+a")?.productId).toBe("p2");
    expect(matchProductByScanCode(catalog, "fallback-sku")?.productId).toBe("p3");
    expect(matchProductByScanCode(catalog, "UNKNOWN-999")).toBeUndefined();
  });
});
