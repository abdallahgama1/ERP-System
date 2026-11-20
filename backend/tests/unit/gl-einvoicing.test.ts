import { describe, expect, it } from "vitest";
import { validateAndNormalizeJournalLines } from "../../src/services/gl.service.ts";
import { computeInvoiceHash, encodeZatcaTlvQr } from "../../src/services/einvoicing.service.ts";

describe("Double-entry GL validation & ZATCA e-invoicing", () => {
  it("accepts balanced double-entry journal lines and computes FX base amounts", () => {
    const res = validateAndNormalizeJournalLines([
      { accountId: "acct-ar", debit: 100, credit: 0, currency: "EUR", fxRate: 1.1 },
      { accountId: "acct-rev", debit: 0, credit: 110, currency: "USD", fxRate: 1 },
    ]);
    expect(res.totalDebit).toBe(110);
    expect(res.totalCredit).toBe(110);
    expect(res.pennyDiffPlugged).toBe(0);
    expect(res.normalizedLines[0].debitBase).toBe(110);
    expect(res.normalizedLines[0].debitTx).toBe(100);
  });

  it("plugs small <= 0.05 rounding discrepancies into rounding_variance account when provided", () => {
    const res = validateAndNormalizeJournalLines(
      [
        { accountId: "acct-ar", debit: 100.02, credit: 0 },
        { accountId: "acct-rev", debit: 0, credit: 100 },
      ],
      "acct-rounding"
    );
    expect(res.totalDebit).toBe(100.02);
    expect(res.totalCredit).toBe(100.02);
    expect(res.pennyDiffPlugged).toBe(0.02);
    const plugLine = res.normalizedLines.find((l) => l.accountId === "acct-rounding");
    expect(plugLine).toBeDefined();
    expect(plugLine?.creditBase).toBe(0.02);
  });

  it("throws UNBALANCED_JOURNAL when diff exceeds threshold or has only one line", () => {
    expect(() =>
      validateAndNormalizeJournalLines([
        { accountId: "acct-ar", debit: 100, credit: 0 },
        { accountId: "acct-rev", debit: 0, credit: 95 },
      ], "acct-rounding")
    ).toThrow(/Unbalanced journal entry/);

    expect(() =>
      validateAndNormalizeJournalLines([{ accountId: "acct-ar", debit: 10, credit: 0 }])
    ).toThrow(/at least two lines/);
  });

  it("encodes ZATCA Phase-1 Base64 TLV QR tags 1-5 faithfully", () => {
    const b64 = encodeZatcaTlvQr({
      sellerName: "Acme ERP Ltd",
      taxNumber: "300000000000003",
      timestampIso: "2026-11-20T12:00:00.000Z",
      totalWithVat: "115.00",
      vatTotal: "15.00",
    });

    const buf = Buffer.from(b64, "base64");
    const parsed: Record<number, string> = {};
    let offset = 0;
    while (offset < buf.length) {
      const tag = buf[offset];
      const len = buf[offset + 1];
      parsed[tag] = buf.subarray(offset + 2, offset + 2 + len).toString("utf8");
      offset += 2 + len;
    }

    expect(parsed).toEqual({
      1: "Acme ERP Ltd",
      2: "300000000000003",
      3: "2026-11-20T12:00:00.000Z",
      4: "115.00",
      5: "15.00",
    });
  });

  it("produces deterministic chained SHA-256 invoice hashes", () => {
    const h1 = computeInvoiceHash({
      invoiceNumber: "INV-0001",
      invoiceDateIso: "2026-11-20T00:00:00.000Z",
      totalAmount: "115.00",
      taxTotal: "15.00",
      prevHash: "0".repeat(64),
    });
    const h2 = computeInvoiceHash({
      invoiceNumber: "INV-0001",
      invoiceDateIso: "2026-11-20T00:00:00.000Z",
      totalAmount: "115.00",
      taxTotal: "15.00",
      prevHash: "a".repeat(64),
    });

    expect(h1).toHaveLength(64);
    expect(h2).toHaveLength(64);
    expect(h1).not.toBe(h2);
  });
});
