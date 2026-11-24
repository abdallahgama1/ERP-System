import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ALLOWED_MIME_TYPES,
  ATTACHMENT_MAX_BYTES,
  AUDIT_SENSITIVE_FIELDS,
  DEFAULT_COMPANY_CODE,
  DEFAULT_COMPANY_ID,
  DEFAULT_PERMISSION_MATRIX,
  DEFAULT_POS_MAX_CASHIER_DISCOUNT_PCT,
  EINVOICE_DOCUMENT_TYPES,
  EINVOICE_PROVIDERS,
  EINVOICE_SUBMISSION_STATUSES,
  ETA_RECEIPT_STATUSES,
  ETA_RECEIPT_TYPES,
  PERMISSION_ACTIONS,
  PERMISSION_MODULES,
  SYSTEM_ROLE_PRESETS,
  approvalDecisionSchema,
  attachmentFileMetaSchema,
  attachmentListQuerySchema,
  buildEmptyPermissionRecord,
  buildOffsetPageInfo,
  calculateDocumentTotals,
  calculateLineAmounts,
  createCompanySchema,
  createCostCenterSchema,
  createCustomRoleSchema,
  createExpenseClaimSchema,
  createPrintTemplateSchema,
  createSavedViewSchema,
  createTreasuryAccountSchema,
  createTreasuryTransferSchema,
  cursorPageQuerySchema,
  customersListQuerySchema,
  decodeCursor,
  einvoiceQueueQuerySchema,
  einvoiceRetrySchema,
  emailDocumentSchema,
  encodeCursor,
  expenseClaimsListQuerySchema,
  exportParamsSchema,
  exportQuerySchema,
  globalSearchQuerySchema,
  importBankStatementCsvSchema,
  mfaDisableSchema,
  mfaRegenerateRecoveryCodesSchema,
  mfaVerifyEnrollSchema,
  mfaVerifyLoginSchema,
  normalizeRolePermissionsMap,
  offsetPageQuerySchema,
  parseBackwardCompatibleOffsetQuery,
  payExpenseClaimSchema,
  posCheckoutSchema,
  posManagerOverrideSchema,
  posReceiptsQuerySchema,
  posReturnLineSchema,
  posReturnSchema,
  productsListQuerySchema,
  purchaseOrdersListQuerySchema,
  reconcileStatementLineSchema,
  resolveSearchTerm,
  reviewExpenseClaimSchema,
  salesOrdersListQuerySchema,
  setCashierPinSchema,
  switchCompanySchema,
  updateCustomRoleSchema,
  updatePrintTemplateSchema,
  upsertApprovalRuleSchema,
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

  it("exposes 21 permission modules, 8 complete system role presets, and permission helpers", () => {
    expect(PERMISSION_MODULES).toHaveLength(21);
    for (const mod of ["manufacturing", "treasury", "expenses", "fixed_assets", "approvals", "einvoicing", "audit", "companies", "roles"] as const) {
      expect(PERMISSION_MODULES).toContain(mod);
      expect(DEFAULT_PERMISSION_MATRIX.admin[mod]).toEqual({
        view: true,
        create: true,
        edit: true,
        delete: true,
        approve: true,
      });
    }

    expect(SYSTEM_ROLE_PRESETS).toHaveLength(8);
    expect(SYSTEM_ROLE_PRESETS.map((p) => p.name)).toEqual([
      "Admin",
      "Finance Manager",
      "Accountant",
      "Warehouse Manager",
      "Purchasing Officer",
      "Sales Manager",
      "Branch Manager",
      "Cashier",
    ]);

    for (const preset of SYSTEM_ROLE_PRESETS) {
      for (const mod of PERMISSION_MODULES) {
        expect(preset.permissions[mod]).toBeDefined();
        for (const action of PERMISSION_ACTIONS) {
          expect(typeof preset.permissions[mod][action]).toBe("boolean");
        }
      }
    }

    const empty = buildEmptyPermissionRecord();
    for (const mod of PERMISSION_MODULES) {
      expect(empty[mod]).toEqual({ view: false, create: false, edit: false, delete: false, approve: false });
    }

    const normalized = normalizeRolePermissionsMap({
      sales: { view: true, create: true },
    });
    expect(normalized.sales).toEqual({ view: true, create: true, edit: false, delete: false, approve: false });
    expect(normalized.accounting).toEqual({ view: false, create: false, edit: false, delete: false, approve: false });

    const coerced = normalizeRolePermissionsMap({
      companies: {
        view: "false" as unknown as boolean,
        create: 1 as unknown as boolean,
        edit: true,
        delete: "0" as unknown as boolean,
        approve: "true" as unknown as boolean,
      },
    });
    expect(coerced.companies).toEqual({
      view: false,
      create: false,
      edit: true,
      delete: false,
      approve: false,
    });
    expect(normalizeRolePermissionsMap(["sales"] as unknown as null)).toEqual(empty);
  });

  it("validates Wave 1 enterprise contracts (multi-company, custom roles, MFA, search, views, exports, attachments, print, email)", () => {
    expect(DEFAULT_COMPANY_ID).toBe("00000000-0000-4000-8000-000000000001");
    expect(DEFAULT_COMPANY_CODE).toBe("COMP-01");
    expect(AUDIT_SENSITIVE_FIELDS).toContain("passwordHash");
    expect(AUDIT_SENSITIVE_FIELDS).toContain("totpSecretEncrypted");

    // Preserved D1 approval schemas
    expect(upsertApprovalRuleSchema.parse({ entityType: "purchase_order", minAmount: 1000 })).toMatchObject({
      entityType: "purchase_order",
      minAmount: 1000,
      requiredRole: "manager",
      isActive: false,
    });
    expect(approvalDecisionSchema.parse({ decision: "approved" })).toEqual({ decision: "approved", comment: "" });

    // Multi-company
    const company = createCompanySchema.parse({ code: "comp-02", name: "Branch Entity Ltd" });
    expect(company.code).toBe("COMP-02");
    expect(createCompanySchema.safeParse({ code: "bad code!", name: "X" }).success).toBe(false);
    expect(switchCompanySchema.safeParse({ companyId: DEFAULT_COMPANY_ID }).success).toBe(true);
    expect(switchCompanySchema.safeParse({ companyId: "bad" }).success).toBe(false);

    // Custom roles (strict complete 18-module coverage)
    const customRole = createCustomRoleSchema.parse({
      name: "Regional Auditor",
      baseRole: "user",
      permissions: normalizeRolePermissionsMap({ audit: { view: true } }),
    });
    expect(customRole.name).toBe("Regional Auditor");
    expect(customRole.permissions.audit.view).toBe(true);
    expect(createCustomRoleSchema.safeParse({ name: "Incomplete Role", permissions: {} }).success).toBe(false);
    expect(
      createCustomRoleSchema.safeParse({
        name: "Partial Role",
        permissions: { sales: { view: true, create: false, edit: false, delete: false, approve: false } },
      }).success
    ).toBe(false);
    expect(
      createCustomRoleSchema.safeParse({
        name: "Unknown Module Role",
        permissions: {
          ...normalizeRolePermissionsMap(),
          nonexistent_module: { view: true, create: false, edit: false, delete: false, approve: false },
        },
      }).success
    ).toBe(false);
    expect(updateCustomRoleSchema.parse({ name: "Renamed Role" })).toEqual({ name: "Renamed Role" });
    expect(updateCustomRoleSchema.safeParse({ permissions: {} }).success).toBe(false);

    // TOTP MFA
    expect(mfaVerifyEnrollSchema.safeParse({ code: "123456" }).success).toBe(true);
    expect(mfaVerifyEnrollSchema.safeParse({ code: "12ab56" }).success).toBe(false);
    expect(mfaVerifyLoginSchema.safeParse({ mfaChallengeToken: "token-123456789", code: "123456" }).success).toBe(true);
    expect(mfaDisableSchema.safeParse({ password: "secret" }).success).toBe(true);
    expect(mfaRegenerateRecoveryCodesSchema.safeParse({}).success).toBe(false);
    expect(mfaRegenerateRecoveryCodesSchema.safeParse({ password: "secret" }).success).toBe(true);
    expect(mfaRegenerateRecoveryCodesSchema.safeParse({ code: "123456" }).success).toBe(true);

    // Search, Saved Views, Exports
    expect(globalSearchQuerySchema.parse({ q: "  INV-001 " })).toEqual({ q: "INV-001", limit: 20 });
    expect(globalSearchQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(createSavedViewSchema.parse({ resource: "invoices", name: "Overdue Only" })).toMatchObject({
      resource: "invoices",
      name: "Overdue Only",
      isDefault: false,
    });
    expect(exportParamsSchema.safeParse({ resource: "invoices" }).success).toBe(true);
    expect(exportParamsSchema.safeParse({ resource: "unknown" }).success).toBe(false);
    expect(exportQuerySchema.parse({})).toEqual({ format: "csv" });
    expect(exportQuerySchema.parse({ format: "xlsx" }).format).toBe("xlsx");

    // Attachments (10MB + strict MIME allowlist)
    expect(ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(ATTACHMENT_ALLOWED_MIME_TYPES).toContain("application/pdf");
    expect(ATTACHMENT_ALLOWED_MIME_TYPES).not.toContain("application/x-msdownload");
    expect(attachmentListQuerySchema.safeParse({ entityType: "invoice", entityId: DEFAULT_COMPANY_ID }).success).toBe(
      true
    );
    expect(
      attachmentFileMetaSchema.parse({
        fileName: "  invoice.pdf  ",
        mimeType: "application/pdf",
        sizeBytes: ATTACHMENT_MAX_BYTES,
      })
    ).toEqual({
      fileName: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: ATTACHMENT_MAX_BYTES,
    });
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "image/png", sizeBytes: 1 }).success).toBe(true);
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "application/pdf", sizeBytes: 0 }).success).toBe(false);
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "application/pdf", sizeBytes: -1 }).success).toBe(false);
    expect(
      attachmentFileMetaSchema.safeParse({ mimeType: "application/pdf", sizeBytes: ATTACHMENT_MAX_BYTES + 1 }).success
    ).toBe(false);
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "text/html", sizeBytes: 100 }).success).toBe(false);
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "application/javascript", sizeBytes: 100 }).success).toBe(
      false
    );
    expect(attachmentFileMetaSchema.safeParse({ mimeType: "image/svg+xml", sizeBytes: 100 }).success).toBe(false);

    // Print templates & Document emailing
    expect(createPrintTemplateSchema.parse({ documentType: "invoice", name: "Modern A4" })).toMatchObject({
      documentType: "invoice",
      name: "Modern A4",
      accentColor: "#0f172a",
      logoUrl: "",
    });
    expect(
      createPrintTemplateSchema.safeParse({
        documentType: "invoice",
        name: "Relative Logo",
        logoUrl: "/assets/logo.png",
      }).success
    ).toBe(true);
    expect(
      createPrintTemplateSchema.safeParse({
        documentType: "invoice",
        name: "HTTPS Logo",
        logoUrl: "https://cdn.example.com/logo.png",
      }).success
    ).toBe(true);
    expect(
      createPrintTemplateSchema.safeParse({
        documentType: "invoice",
        name: "XSS Logo",
        logoUrl: "javascript:alert(1)",
      }).success
    ).toBe(false);
    expect(
      createPrintTemplateSchema.safeParse({
        documentType: "invoice",
        name: "Protocol Relative Logo",
        logoUrl: "//evil.example.com/logo.png",
      }).success
    ).toBe(false);
    expect(
      createPrintTemplateSchema.safeParse({
        documentType: "invoice",
        name: "Data HTML Logo",
        logoUrl: "data:text/html,<script>alert(1)</script>",
      }).success
    ).toBe(false);
    expect(updatePrintTemplateSchema.parse({ name: "Renamed Template" })).toEqual({ name: "Renamed Template" });
    expect(updatePrintTemplateSchema.safeParse({ logoUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(
      createPrintTemplateSchema.safeParse({ documentType: "invoice", name: "Bad", accentColor: "red" }).success
    ).toBe(false);
    expect(
      emailDocumentSchema.parse({
        to: "customer@example.com",
        subject: "Invoice INV-0001",
      })
    ).toMatchObject({
      to: "customer@example.com",
      subject: "Invoice INV-0001",
      attachStoredFiles: false,
    });
    expect(emailDocumentSchema.safeParse({ to: "not-an-email", subject: "Hi" }).success).toBe(false);
    expect(
      emailDocumentSchema.safeParse({
        to: "customer@example.com",
        subject: "Invoice\r\nBcc: attacker@evil.com",
      }).success
    ).toBe(false);
    expect(
      emailDocumentSchema.safeParse({
        to: "customer@example.com",
        subject: "Invoice\nX-Injected: true",
      }).success
    ).toBe(false);
  });

  it("validates Wave 2A finance contracts (cost centers, treasury, bank reconciliation, operating expenses)", () => {
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";

    // Cost center uppercases code & rejects invalid characters
    expect(createCostCenterSchema.parse({ code: "cc-ops", name: "Operations" })).toMatchObject({
      code: "CC-OPS",
      name: "Operations",
      isActive: true,
    });
    expect(createCostCenterSchema.safeParse({ code: "bad code!", name: "Ops" }).success).toBe(false);

    // Treasury account & self-transfer rejection
    expect(createTreasuryAccountSchema.parse({ code: "bnk-cib", name: "CIB Main", accountType: "bank" })).toMatchObject({
      code: "BNK-CIB",
      accountType: "bank",
      currency: "USD",
      openingBalance: 0,
    });
    expect(
      createTreasuryTransferSchema.safeParse({
        fromTreasuryAccountId: idA,
        toTreasuryAccountId: idA,
        amount: 250,
      }).success
    ).toBe(false);
    expect(
      createTreasuryTransferSchema.safeParse({
        fromTreasuryAccountId: idA,
        toTreasuryAccountId: idB,
        amount: 250,
      }).success
    ).toBe(true);

    // CSV import & reconciliation XOR rule
    expect(importBankStatementCsvSchema.parse({ csvText: "date,amount\n2026-11-01,100" }).fileName).toBe(
      "statement.csv"
    );
    expect(reconcileStatementLineSchema.safeParse({ journalLineId: idA }).success).toBe(true);
    expect(
      reconcileStatementLineSchema.safeParse({ createAdjustment: { counterpartAccountId: idB } }).success
    ).toBe(true);
    expect(reconcileStatementLineSchema.safeParse({}).success).toBe(false);
    expect(
      reconcileStatementLineSchema.safeParse({
        journalLineId: idA,
        createAdjustment: { counterpartAccountId: idB },
      }).success
    ).toBe(false);

    // Expense claims & settlement
    const claim = createExpenseClaimSchema.parse({
      paymentMode: "employee_reimbursement",
      payeeName: "Sara Mahmoud",
      lines: [{ expenseAccountId: idA, description: "Client taxi", netAmount: 100, taxRate: 14 }],
    });
    expect(claim.submitNow).toBe(true);
    expect(claim.lines).toHaveLength(1);
    expect(createExpenseClaimSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(reviewExpenseClaimSchema.parse({ decision: "approved" })).toEqual({
      decision: "approved",
      comment: "",
    });
    expect(payExpenseClaimSchema.safeParse({ treasuryAccountId: idB }).success).toBe(true);
    expect(expenseClaimsListQuerySchema.parse({ status: "all", paymentMode: "" })).toMatchObject({
      page: 1,
      pageSize: 50,
      status: undefined,
      paymentMode: undefined,
    });
  });
});
