import { describe, expect, it } from "vitest";
import {
  buildEtaEgyptQrUrl,
  buildEtaEgyptReceiptPayload,
  computeEtaReceiptUuid,
  serializeEtaCanonicalDocument,
} from "../../src/services/einvoicing.service.ts";

describe("ETA Egypt e-Receipt v1.2 canonicalization & UUID generation", () => {
  it("serializes nested objects and arrays with uppercase keys deterministically", () => {
    const serialized = serializeEtaCanonicalDocument({
      header: { receiptNumber: "POS-00001", uuid: "" },
      itemData: [{ internalCode: "SKU-1", quantity: 2 }],
    });

    expect(serialized).toBe(
      `"HEADER""RECEIPTNUMBER""POS-00001""UUID""""ITEMDATA""ITEMDATA""INTERNALCODE""SKU-1""QUANTITY""2"`
    );
  });

  it("computes deterministic 64-char SHA-256 uuid and official ETA share QR URL", () => {
    const input = {
      receiptNumber: "POS-00042",
      dateTimeIssuedIso: "2026-11-21T08:00:00.000Z",
      previousUuid: "",
      currency: "EGP",
      sellerName: "Cairo Retail LLC",
      sellerTaxNumber: "123456789",
      branchCode: "0",
      branchAddress: "Tahrir Sq",
      posSerialNumber: "POS-EG-01",
      buyerName: "Walk-in Customer",
      paymentMethod: "C" as const,
      subtotal: 100,
      taxTotal: 14,
      totalAmount: 114,
      lines: [
        {
          description: "Coffee Beans",
          itemCode: "EG-123456789-COF1",
          quantity: 1,
          unitPrice: 100,
          taxRate: 14,
          taxAmount: 14,
          lineTotal: 114,
        },
      ],
    };

    const first = buildEtaEgyptReceiptPayload(input);
    const second = buildEtaEgyptReceiptPayload(input);

    expect(first.etaUuid).toMatch(/^[a-f0-9]{64}$/);
    expect(first.etaUuid).toBe(second.etaUuid);
    expect(computeEtaReceiptUuid(first.payload)).toBe(first.etaUuid);
    expect(first.qrUrl).toBe(buildEtaEgyptQrUrl(first.etaUuid, "2026-11-21T08:00:00Z"));
    expect(first.qrUrl).toContain("https://invoicing.eta.gov.eg/receipts/search/");
  });
});
