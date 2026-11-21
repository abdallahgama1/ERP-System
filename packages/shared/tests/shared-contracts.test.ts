import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MATRIX,
  PERMISSION_MODULES,
  buildOffsetPageInfo,
  calculateDocumentTotals,
  calculateLineAmounts,
  cursorPageQuerySchema,
  decodeCursor,
  encodeCursor,
  offsetPageQuerySchema,
  posCheckoutSchema,
  setCashierPinSchema,
} from "../src/index.ts";

describe("@erp/shared contracts (pricing, pagination, permissions & POS)", () => {
  it("computes tax-exclusive and tax-inclusive (retail POS) line totals accurately", () => {
    const excl = calculateLineAmounts({ quantity: 2, unitPrice: 100, taxRate: 15, isTaxInclusive: false });
    expect(excl).toEqual({ gross: 200, taxable: 200, taxAmount: 30, lineTotal: 230 });

    const incl = calculateLineAmounts({ quantity: 1, unitPrice: 115, taxRate: 15, isTaxInclusive: true });
    expect(incl).toEqual({ gross: 115, taxable: 100, taxAmount: 15, lineTotal: 115 });

    const doc = calculateDocumentTotals([
      { quantity: 1, unitPrice: 114, taxRate: 14, isTaxInclusive: true },
      { quantity: 2, unitPrice: 57, taxRate: 14, isTaxInclusive: true },
    ]);
    expect(doc).toEqual({ subtotal: 200, taxTotal: 28, grandTotal: 228 });
  });

  it("encodes/decodes versioned keyset cursors and rejects malformed cursors", () => {
    const ts = "2026-11-21T08:00:00.000Z";
    const id = "11111111-1111-4111-8111-111111111111";
    const encoded = encodeCursor(ts, id);
    expect(decodeCursor(encoded)).toEqual({ v: 1, ts, id });
    expect(decodeCursor("not-a-valid-cursor!!!")).toBeNull();

    const parsedCursorQ = cursorPageQuerySchema.parse({ limit: "25" });
    expect(parsedCursorQ).toEqual({ limit: 25, sortDir: "desc" });

    const parsedOffsetQ = offsetPageQuerySchema.parse({ page: "2", pageSize: "20" });
    expect(parsedOffsetQ).toEqual({ page: 2, pageSize: 20, sortDir: "desc" });
    expect(buildOffsetPageInfo(2, 20, 45)).toEqual({
      page: 2,
      pageSize: 20,
      total: 45,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it("includes pos module in permission matrix defaults", () => {
    expect(PERMISSION_MODULES).toContain("pos");
    expect(DEFAULT_PERMISSION_MATRIX.admin.pos.approve).toBe(true);
    expect(DEFAULT_PERMISSION_MATRIX.manager.pos.approve).toBe(true);
    expect(DEFAULT_PERMISSION_MATRIX.user.pos).toEqual({
      view: true,
      create: true,
      edit: false,
      delete: false,
      approve: false,
    });
  });

  it("validates POS split-tender sums and cashier PIN format", () => {
    const terminalId = "11111111-1111-4111-8111-111111111111";
    const shiftId = "22222222-2222-4222-8222-222222222222";
    const productId = "33333333-3333-4333-8333-333333333333";

    const ok = posCheckoutSchema.safeParse({
      terminalId,
      shiftId,
      lines: [{ productId, quantity: 1, unitPrice: 115, taxRate: 15, isTaxInclusive: true }],
      tenders: [
        { method: "cash", amount: 65, tenderedAmount: 100 },
        { method: "card", amount: 50, reference: "AUTH-99" },
      ],
    });
    expect(ok.success).toBe(true);

    const mismatch = posCheckoutSchema.safeParse({
      terminalId,
      shiftId,
      lines: [{ productId, quantity: 1, unitPrice: 115, taxRate: 15, isTaxInclusive: true }],
      tenders: [{ method: "cash", amount: 100, tenderedAmount: 100 }],
    });
    expect(mismatch.success).toBe(false);

    expect(setCashierPinSchema.safeParse({ pin: "1234" }).success).toBe(true);
    expect(setCashierPinSchema.safeParse({ pin: "12a4" }).success).toBe(false);
    expect(setCashierPinSchema.safeParse({ pin: "123" }).success).toBe(false);
  });
});
