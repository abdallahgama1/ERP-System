import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MATRIX,
  DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT,
  EINVOICE_DOCUMENT_TYPES,
  EINVOICE_PROVIDERS,
  EINVOICE_SUBMISSION_STATUSES,
  ETA_RECEIPT_STATUSES,
  ETA_RECEIPT_TYPES,
  PERMISSION_MODULES,
  buildOffsetPageInfo,
  calculateDocumentTotals,
  calculateLineAmounts,
  cursorPageQuerySchema,
  customersListQuerySchema,
  decodeCursor,
  einvoiceQueueQuerySchema,
  einvoiceRetrySchema,
  encodeCursor,
  offsetPageQuerySchema,
  parseBackwardCompatibleOffsetQuery,
  posCheckoutSchema,
  posManagerOverrideSchema,
  posReceiptsQuerySchema,
  posReturnLineSchema,
  posReturnSchema,
  productsListQuerySchema,
  purchaseOrdersListQuerySchema,
  resolveSearchTerm,
  salesOrdersListQuerySchema,
  setCashierPinSchema,
  vendorBillsListQuerySchema,
  vendorsListQuerySchema,
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

  it("exposes POS discount threshold and e-invoicing status/provider constants", () => {
    expect(DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT).toBe(10);
    expect(EINVOICE_SUBMISSION_STATUSES).toEqual(["pending", "submitted", "accepted", "rejected", "failed"]);
    expect(ETA_RECEIPT_STATUSES).toEqual([
      "not_applicable",
      "pending_submission",
      "submitted",
      "accepted",
      "rejected",
      "failed",
    ]);
    expect(EINVOICE_PROVIDERS).toEqual(["eta_egypt", "zatca_phase2"]);
    expect(EINVOICE_DOCUMENT_TYPES).toEqual(["receipt", "invoice"]);
    expect(ETA_RECEIPT_TYPES).toEqual(["S", "R"]);
  });

  it("validates POS return payloads, manager overrides, and receipt search queries", () => {
    const invoiceId = "11111111-1111-4111-8111-111111111111";
    const lineId = "22222222-2222-4222-8222-222222222222";
    const productId = "33333333-3333-4333-8333-333333333333";
    const terminalId = "44444444-4444-4444-8444-444444444444";
    const shiftId = "55555555-5555-4555-8555-555555555555";

    const parsedReturn = posReturnSchema.parse({
      originalInvoiceId: invoiceId,
      terminalId,
      shiftId,
      refundMethod: "cash",
      reason: "Damaged packaging",
      managerOverridePin: "1234",
      lines: [{ originalInvoiceLineId: lineId, productId, quantity: 2 }],
    });
    expect(parsedReturn.restockItems).toBe(true);
    expect(parsedReturn.lines).toHaveLength(1);

    expect(posReturnLineSchema.safeParse({ originalInvoiceLineId: lineId, productId, quantity: 0 }).success).toBe(false);
    expect(
      posReturnSchema.safeParse({
        originalInvoiceId: invoiceId,
        terminalId,
        shiftId,
        refundMethod: "cash",
        reason: "   ",
        lines: [{ originalInvoiceLineId: lineId, productId, quantity: 1 }],
      }).success
    ).toBe(false);
    expect(
      posReturnSchema.safeParse({
        originalInvoiceId: invoiceId,
        terminalId,
        shiftId,
        refundMethod: "wire",
        reason: "Refund",
        lines: [],
      }).success
    ).toBe(false);
    expect(
      posReturnSchema.safeParse({
        originalInvoiceId: invoiceId,
        terminalId,
        shiftId,
        refundMethod: "card",
        reason: "Refund",
        managerOverridePin: "12ab",
        lines: [{ originalInvoiceLineId: lineId, productId, quantity: 1 }],
      }).success
    ).toBe(false);

    const overrideDefault = posManagerOverrideSchema.parse({ pin: "9988" });
    expect(overrideDefault).toEqual({ pin: "9988", action: "discount", reason: "" });
    expect(posManagerOverrideSchema.parse({ pin: "123456", action: "refund", reason: "Customer return" }).action).toBe(
      "refund"
    );
    expect(posManagerOverrideSchema.safeParse({ pin: "12", action: "refund" }).success).toBe(false);
    expect(posManagerOverrideSchema.safeParse({ pin: "1234", action: "unknown" }).success).toBe(false);

    const receiptsDefault = posReceiptsQuerySchema.parse({});
    expect(receiptsDefault).toEqual({ page: 1, pageSize: 50, sortDir: "desc" });

    const receiptsFiltered = posReceiptsQuerySchema.parse({
      page: "2",
      pageSize: "25",
      search: "  POS-00012 ",
      branchId: "all",
      terminalId,
      shiftId: "",
      limit: "100",
    });
    expect(receiptsFiltered).toEqual({
      page: 2,
      pageSize: 25,
      sortDir: "desc",
      search: "POS-00012",
      branchId: undefined,
      terminalId,
      shiftId: undefined,
      limit: 100,
    });
    expect(resolveSearchTerm(receiptsFiltered)).toBe("POS-00012");
    expect(posReceiptsQuerySchema.safeParse({ terminalId: "not-a-uuid" }).success).toBe(false);
    expect(posReceiptsQuerySchema.safeParse({ limit: "250" }).success).toBe(false);
  });

  it("validates ETA e-invoice queue queries and retry payloads", () => {
    const subId = "11111111-1111-4111-8111-111111111111";

    expect(einvoiceQueueQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50, sortDir: "desc" });
    const filtered = einvoiceQueueQuerySchema.parse({
      status: "all",
      provider: "eta_egypt",
      documentType: "",
      q: "POS-0001",
      sortBy: "attempts",
    });
    expect(filtered).toEqual({
      page: 1,
      pageSize: 50,
      sortDir: "desc",
      status: undefined,
      provider: "eta_egypt",
      documentType: undefined,
      q: "POS-0001",
      sortBy: "attempts",
    });
    expect(einvoiceQueueQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);

    expect(einvoiceRetrySchema.parse({})).toEqual({ force: false, resetAttempts: false });
    expect(einvoiceRetrySchema.parse({ submissionIds: [subId], force: true, resetAttempts: true })).toEqual({
      submissionIds: [subId],
      force: true,
      resetAttempts: true,
    });
    expect(einvoiceRetrySchema.safeParse({ submissionIds: [] }).success).toBe(false);
    expect(einvoiceRetrySchema.safeParse({ submissionIds: ["not-a-uuid"] }).success).toBe(false);
  });

  it("validates R6 back-office pagination queries and backward-compatible pageSize helper", () => {
    const branchId = "11111111-1111-4111-8111-111111111111";
    const partnerId = "22222222-2222-4222-8222-222222222222";

    const legacyProducts = parseBackwardCompatibleOffsetQuery(productsListQuerySchema, {});
    expect(legacyProducts).toEqual({ page: 1, pageSize: 200, sortDir: "desc" });

    const pagedProducts = parseBackwardCompatibleOffsetQuery(productsListQuerySchema, {
      page: "3",
      q: "Widget",
      category: "all",
      branchId: "",
      itemType: "stock",
      isActive: "true",
      sortBy: "name",
      sortDir: "asc",
    });
    expect(pagedProducts).toEqual({
      page: 3,
      pageSize: 50,
      sortDir: "asc",
      sortBy: "name",
      q: "Widget",
      category: undefined,
      branchId: undefined,
      itemType: "stock",
      isActive: "true",
    });

    expect(customersListQuerySchema.parse({ sortBy: "code", search: "Acme" })).toMatchObject({
      sortBy: "code",
      search: "Acme",
    });
    expect(vendorsListQuerySchema.parse({ sortBy: "name", q: "  " }).q).toBeUndefined();
    expect(
      salesOrdersListQuerySchema.parse({ sortBy: "soNumber", branchId, customerId: "all", status: "Overdue" })
    ).toMatchObject({
      sortBy: "soNumber",
      branchId,
      customerId: undefined,
      status: "Overdue",
    });
    expect(
      purchaseOrdersListQuerySchema.parse({ sortBy: "poNumber", vendorId: partnerId, status: "Issued" })
    ).toMatchObject({
      sortBy: "poNumber",
      vendorId: partnerId,
      status: "Issued",
    });
    expect(vendorBillsListQuerySchema.parse({ sortBy: "dueDate", vendorId: partnerId })).toMatchObject({
      sortBy: "dueDate",
      vendorId: partnerId,
    });
    expect(salesOrdersListQuerySchema.safeParse({ branchId: "bad-uuid" }).success).toBe(false);
    expect(productsListQuerySchema.safeParse({ sortBy: "invalidCol" }).success).toBe(false);
  });
});
