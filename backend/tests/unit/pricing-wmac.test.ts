import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MATRIX,
  PERMISSION_MODULES,
  calculateDocumentTotals,
  calculateLineAmounts,
  computeWmac,
  createProductSchema,
  createTransferSchema,
  invoiceSchema,
  roundCurrency,
  roundQty,
} from "@erp/shared";

describe("@erp/shared pricing & WMAC helpers", () => {
  it("computes Weighted Moving Average Cost cleanly across receipts", () => {
    expect(computeWmac(0, 0, 10, 50)).toBe(50);
    expect(computeWmac(10, 50, 10, 70)).toBe(60);
    expect(computeWmac(10, 60, 0, 100)).toBe(60);
    expect(computeWmac(-2, 40, 5, 80)).toBe(80);
  });

  it("rounds currency and inventory quantities accurately without binary drift", () => {
    expect(roundCurrency(19.995, 2)).toBe(20);
    expect(roundCurrency(1.005, 2)).toBe(1.01);
    expect(roundQty(2.34567, 4)).toBe(2.3457);
  });

  it("clamps line discounts at gross amount and aggregates totals cleanly", () => {
    const line = calculateLineAmounts({ quantity: 2, unitPrice: 100, discount: 500, taxRate: 15 }, 2);
    expect(line.gross).toBe(200);
    expect(line.taxable).toBe(0);
    expect(line.taxAmount).toBe(0);
    expect(line.lineTotal).toBe(0);

    const doc = calculateDocumentTotals(
      [
        { quantity: 2, unitPrice: 100, discount: 20, taxRate: 10 },
        { quantity: 1, unitPrice: 50, discount: 0, taxRate: 10 },
      ],
      2
    );
    expect(doc.subtotal).toBe(230);
    expect(doc.taxTotal).toBe(23);
    expect(doc.grandTotal).toBe(253);
  });
});

describe("@erp/shared contracts & permission invariants", () => {
  it("enforces schema bounds on inventory, transfers, and invoices", () => {
    expect(createProductSchema.safeParse({ sku: "SKU-1", name: "Item", costPrice: -1 }).success).toBe(false);
    expect(
      createTransferSchema.safeParse({
        fromBranchId: "11111111-1111-4111-8111-111111111111",
        toBranchId: "22222222-2222-4222-8222-222222222222",
        lines: [],
      }).success
    ).toBe(false);
    expect(
      invoiceSchema.safeParse({
        customerId: "11111111-1111-4111-8111-111111111111",
        branchId: "22222222-2222-4222-8222-222222222222",
        dueDate: "2026-12-31",
        lines: [{ quantity: 0, unitPrice: 10 }],
      }).success
    ).toBe(false);
  });

  it("grants admin full access across every permission module and restricts standard users", () => {
    for (const mod of PERMISSION_MODULES) {
      const adminPerms = DEFAULT_PERMISSION_MATRIX.admin[mod];
      expect(adminPerms.view && adminPerms.create && adminPerms.edit && adminPerms.delete && adminPerms.approve).toBe(
        true
      );
    }
    expect(DEFAULT_PERMISSION_MATRIX.user.accounting.view).toBe(false);
    expect(DEFAULT_PERMISSION_MATRIX.user.users.view).toBe(false);
    expect(DEFAULT_PERMISSION_MATRIX.user.products.delete).toBe(false);
  });
});
