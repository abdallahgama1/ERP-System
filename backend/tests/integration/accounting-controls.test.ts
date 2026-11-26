import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppDatabase } from "../../src/db/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const testDbUrl = (process.env.TEST_DATABASE_URL ?? "").trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

function extractCookie(res: { headers: Record<string, unknown> }, name = "erp_session"): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const prefix = `${name}=`;
  const match = list.find((c) => c.startsWith(prefix));
  return match ? match.split(";")[0]! : "";
}

function authHeaders(res: { headers: Record<string, unknown> }): Record<string, string> {
  const session = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrf = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrf ? `${session}; erp_csrf=${csrf}` : session,
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describeWithDb("Accounting Controls: VAT POS Returns, Subledger Reconciliation, COA Type Guards & Controlled Reopen", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string> = {};
  let userHeaders: Record<string, string> = {};
  let adminUserId = "";
  let branchId = "";

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName, resetTestDatabase } = await import("../helpers/db-reset.ts");

    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    await resetTestDatabase(db);
    app = await buildApp({ logger: false });

    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Controls Admin", email: "controls-admin@test.local", password: "AdminPassword123!" },
    });
    expect(adminSignup.statusCode).toBe(201);
    adminUserId = adminSignup.json().user.id;
    adminHeaders = authHeaders(adminSignup);

    const userSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Regular User", email: "controls-user@test.local", password: "UserPassword123!" },
    });
    expect(userSignup.statusCode).toBe(201);
    userHeaders = authHeaders(userSignup);

    const brRes = await app.inject({ method: "GET", url: "/api/branches", headers: adminHeaders });
    branchId = brRes.json().branches[0].id;

    await app.inject({
      method: "PUT",
      url: `/api/users/${adminUserId}/pos-pin`,
      headers: adminHeaders,
      payload: { pin: "2468" },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("1. includes POS returns (POSR-*) in VAT Return Summary and reconciles every subledger against GL control accounts", async () => {
    // Seed Treasury, Fixed Asset, Purchase Receive/Bill/Return/Payment, Sales Invoice/Return/Receipt, POS Sale & POS Return
    const bankRes = await app.inject({
      method: "POST",
      url: "/api/treasury/accounts",
      headers: adminHeaders,
      payload: {
        code: "BNK-REC",
        name: "Reconciliation Bank",
        accountType: "bank",
        openingBalance: 30000,
        openingBalanceDate: "2026-01-05",
      },
    });
    expect(bankRes.statusCode).toBe(201);
    const bankGlId = bankRes.json().account.glAccountId as string;

    const faRes = await app.inject({
      method: "POST",
      url: "/api/fixed-assets",
      headers: adminHeaders,
      payload: {
        name: "Barcode Scanner Rig",
        branchId,
        acquisitionDate: "2026-01-10",
        acquisitionCost: 1200,
        salvageValue: 0,
        usefulLifeMonths: 12,
        fundingAccountId: bankGlId,
      },
    });
    expect(faRes.statusCode).toBe(201);

    const depRes = await app.inject({
      method: "POST",
      url: "/api/fixed-assets/depreciate",
      headers: adminHeaders,
      payload: { periodKey: "2026-01", postingDate: "2026-01-31" },
    });
    expect(depRes.statusCode).toBe(200);

    const prodRes = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: { sku: "VAT-POS-SKU", name: "VAT POS Product", costPrice: 50, sellingPrice: 100, initialStock: [] },
    });
    expect(prodRes.statusCode).toBe(201);
    const productId = prodRes.json().product.id as string;

    const vendRes = await app.inject({
      method: "POST",
      url: "/api/vendors",
      headers: adminHeaders,
      payload: { name: "VAT Vendor" },
    });
    const vendorId = vendRes.json().vendor.id as string;

    const rcvRes = await app.inject({
      method: "POST",
      url: "/api/purchase-receives",
      headers: adminHeaders,
      payload: { vendorId, branchId, receiveDate: "2026-02-01", lines: [{ productId, quantity: 20, unitCost: 50 }] },
    });
    expect(rcvRes.statusCode).toBe(201);
    const receiveId = rcvRes.json().receive.id as string;

    const billRes = await app.inject({
      method: "POST",
      url: "/api/vendor-bills",
      headers: adminHeaders,
      payload: {
        vendorId,
        branchId,
        receiveId,
        billDate: "2026-02-02",
        dueDate: "2026-03-02",
        lines: [{ productId, description: "Batch", quantity: 20, unitCost: 50, taxRate: 14 }],
      },
    });
    expect(billRes.statusCode).toBe(201);

    const termRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminals",
      headers: adminHeaders,
      payload: { branchId, code: "REG-VAT", name: "VAT Test POS" },
    });
    const terminalId = termRes.json().terminal.id as string;
    const shiftRes = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      headers: adminHeaders,
      payload: { terminalId, openingFloat: 100 },
    });
    const shiftId = shiftRes.json().shift.id as string;

    // POS Sale: 5 units @ 100 + 14% VAT = 500 + 70 = 570
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: adminHeaders,
      payload: {
        terminalId,
        shiftId,
        lines: [{ productId, quantity: 5, unitPrice: 100, taxRate: 14 }],
        tenders: [{ method: "cash", amount: 570, tenderedAmount: 570 }],
      },
    });
    expect(checkoutRes.statusCode).toBe(201);
    const posSale = checkoutRes.json().receipt;

    const detailRes = await app.inject({
      method: "GET",
      url: `/api/pos/receipts/${posSale.id}`,
      headers: adminHeaders,
    });
    const origLineId = detailRes.json().receipt.lines[0].id as string;

    // POS Return: 2 units @ 100 + 14% VAT = 200 + 28 = 228
    const posRetRes = await app.inject({
      method: "POST",
      url: "/api/pos/returns",
      headers: adminHeaders,
      payload: {
        originalInvoiceId: posSale.id,
        terminalId,
        shiftId,
        refundMethod: "cash",
        restockItems: true,
        reason: "POS VAT regression check",
        managerOverridePin: "2468",
        lines: [{ originalInvoiceLineId: origLineId, productId, quantity: 2 }],
      },
    });
    expect(posRetRes.statusCode).toBe(201);

    // VAT Return Summary must subtract POSR-* Output VAT (70 - 28 = 42) and match GL 2300 exactly!
    const vatRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/vat-return",
      headers: adminHeaders,
    });
    expect(vatRes.statusCode).toBe(200);
    const vat = vatRes.json();
    expect(vat.totalOutputTaxable).toBe(300);
    expect(vat.totalOutputVat).toBe(42);
    expect(vat.glOutputVatBalance).toBe(42);
    expect(vat.totalInputVat).toBe(140);
    expect(vat.glInputVatBalance).toBe(140);
    expect(vat.netVatPayable).toBe(-98);
    expect(vat.glNetVatPayable).toBe(-98);

    // Non-admin is forbidden from reconciliation endpoint
    const userRecon = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/reconciliation",
      headers: userHeaders,
    });
    expect(userRecon.statusCode).toBe(403);

    // Admin gets full 8-control reconciliation and every control matches GL
    const adminRecon = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/reconciliation",
      headers: adminHeaders,
    });
    expect(adminRecon.statusCode).toBe(200);
    const recon = adminRecon.json();
    expect(recon.allReconciled).toBe(true);
    expect(recon.items.length).toBe(8);
    for (const item of recon.items) {
      expect(item.isReconciled).toBe(true);
      expect(Math.abs(item.variance)).toBeLessThanOrEqual(0.02);
    }
  });

  it("2. refuses to silently bind 3100/5600/5610 when a custom COA uses mismatched account_types and surfaces issues in setup-health", async () => {
    const { chartOfAccounts, glAccountMappings } = await import("../../drizzle/schema.ts");
    const { ensureAccountingDefaults } = await import("../../src/services/gl.service.ts");

    // Simulate a pre-existing custom COA where 3100 is liability, 5600 is asset, and 5610 is revenue
    await db
      .delete(glAccountMappings)
      .where(inArray(glAccountMappings.mappingKey, ["retained_earnings", "realized_fx", "unrealized_fx"]));

    await db
      .update(chartOfAccounts)
      .set({ name: "Custom Shareholder Loan", accountType: "liability", normalBalance: "credit" })
      .where(eq(chartOfAccounts.code, "3100"));
    await db
      .update(chartOfAccounts)
      .set({ name: "Custom Prepaid Asset", accountType: "asset", normalBalance: "debit" })
      .where(eq(chartOfAccounts.code, "5600"));
    await db
      .update(chartOfAccounts)
      .set({ name: "Custom Other Revenue", accountType: "revenue", normalBalance: "credit" })
      .where(eq(chartOfAccounts.code, "5610"));

    // Running ensureAccountingDefaults MUST NOT bind any of the three mismatched accounts
    await ensureAccountingDefaults(db);

    const bound = await db
      .select()
      .from(glAccountMappings)
      .where(inArray(glAccountMappings.mappingKey, ["retained_earnings", "realized_fx", "unrealized_fx"]));
    expect(bound).toHaveLength(0);

    // Non-admin is forbidden from setup-health
    const userHealth = await app.inject({
      method: "GET",
      url: "/api/accounting/setup-health",
      headers: userHeaders,
    });
    expect(userHealth.statusCode).toBe(403);

    // Admin setup-health surfaces all 3 collisions with clear instructions
    const healthRes = await app.inject({
      method: "GET",
      url: "/api/accounting/setup-health",
      headers: adminHeaders,
    });
    expect(healthRes.statusCode).toBe(200);
    const health = healthRes.json();
    expect(health.healthy).toBe(false);
    const issueKeys = (health.issues as Array<{ mappingKey: string }>).map((i) => i.mappingKey).sort();
    expect(issueKeys).toEqual(["realized_fx", "retained_earnings", "unrealized_fx"]);
    for (const issue of health.issues as Array<{
      collidingAccountCode: string | null;
      instructions: string;
    }>) {
      expect(issue.collidingAccountCode).toBeTruthy();
      expect(issue.instructions).toContain("PUT /api/accounting/mappings");
    }

    // Attempting to manually bind retained_earnings to the mismatched liability 3100 is rejected with 400
    const [bad3100] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.code, "3100")).limit(1);
    const badBind = await app.inject({
      method: "PUT",
      url: "/api/accounting/mappings",
      headers: adminHeaders,
      payload: { mappingKey: "retained_earnings", accountId: bad3100!.id },
    });
    expect(badBind.statusCode).toBe(400);
    expect(badBind.json().code).toBe("INVALID_MAPPING_ACCOUNT_TYPE");

    // Create dedicated properly-typed accounts and bind them -> setup-health becomes healthy!
    const reAcct = (
      await app.inject({
        method: "POST",
        url: "/api/accounting/accounts",
        headers: adminHeaders,
        payload: { code: "3105", name: "Retained Earnings (Dedicated)", accountType: "equity" },
      })
    ).json().account;
    const rfxAcct = (
      await app.inject({
        method: "POST",
        url: "/api/accounting/accounts",
        headers: adminHeaders,
        payload: { code: "5605", name: "Realized FX (Dedicated)", accountType: "expense" },
      })
    ).json().account;
    const ufxAcct = (
      await app.inject({
        method: "POST",
        url: "/api/accounting/accounts",
        headers: adminHeaders,
        payload: { code: "5615", name: "Unrealized FX (Dedicated)", accountType: "expense" },
      })
    ).json().account;

    for (const [mappingKey, accountId] of [
      ["retained_earnings", reAcct.id],
      ["realized_fx", rfxAcct.id],
      ["unrealized_fx", ufxAcct.id],
    ]) {
      const bindRes = await app.inject({
        method: "PUT",
        url: "/api/accounting/mappings",
        headers: adminHeaders,
        payload: { mappingKey, accountId },
      });
      expect(bindRes.statusCode).toBe(200);
    }

    const fixedHealth = (
      await app.inject({ method: "GET", url: "/api/accounting/setup-health", headers: adminHeaders })
    ).json();
    expect(fixedHealth.healthy).toBe(true);
    expect(fixedHealth.issues).toHaveLength(0);
  });

  it("3. supports controlled admin fiscal year reopen with required reason, dated closing reversal, re-close, and valid audit hash chain", async () => {
    const fyRes = await app.inject({
      method: "POST",
      url: "/api/accounting/fiscal-years",
      headers: adminHeaders,
      payload: { name: "FY 2024", startDate: "2024-01-01", endDate: "2024-12-31" },
    });
    expect(fyRes.statusCode).toBe(201);
    const fyId = fyRes.json().fiscalYear.id as string;

    const coa = (
      await app.inject({ method: "GET", url: "/api/accounting/accounts", headers: adminHeaders })
    ).json().accounts as Array<{ id: string; code: string }>;
    const cashId = coa.find((a) => a.code === "1000")!.id;
    const revId = coa.find((a) => a.code === "4000")!.id;
    const expId = coa.find((a) => a.code === "5500")!.id;

    // Post initial FY 2024 activity: Revenue 10,000, Expense 3,000 -> Net Income 7,000
    const je1 = await app.inject({
      method: "POST",
      url: "/api/accounting/journal-entries",
      headers: adminHeaders,
      payload: {
        entryDate: "2024-06-15",
        memo: "FY 2024 initial activity",
        lines: [
          { accountId: cashId, debit: 7000, credit: 0 },
          { accountId: expId, debit: 3000, credit: 0 },
          { accountId: revId, debit: 0, credit: 10000 },
        ],
      },
    });
    expect(je1.statusCode).toBe(201);

    // Close FY 2024 -> 7,000 transferred to Retained Earnings (3105 from test 2)
    const close1 = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/close`,
      headers: adminHeaders,
      payload: { memo: "Initial close FY 2024" },
    });
    expect(close1.statusCode).toBe(200);
    expect(close1.json().netIncomeTransferred).toBe(7000);
    const originalClosingId = close1.json().journalEntryId as string;

    // Non-admin reopen attempt -> 403
    const userReopen = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/reopen`,
      headers: userHeaders,
      payload: { reason: "Unauthorized attempt" },
    });
    expect(userReopen.statusCode).toBe(403);

    // Missing/too-short reason -> 400
    const badReason = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/reopen`,
      headers: adminHeaders,
      payload: { reason: "no" },
    });
    expect(badReason.statusCode).toBe(400);

    // Admin reopens FY 2024 with valid reason
    const reopenRes = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/reopen`,
      headers: adminHeaders,
      payload: { reason: "Late auditor accrual for FY 2024 utility invoice" },
    });
    expect(reopenRes.statusCode).toBe(200);
    const reopenBody = reopenRes.json();
    expect(reopenBody.status).toBe("open");
    expect(reopenBody.reversedClosingEntryId).toBe(originalClosingId);
    expect(reopenBody.reversalEntryNumber).toMatch(/^JE-/);
    expect(reopenBody.periodsReopened).toBe(12);

    // Verify reversal JE is dated at fy.endDate (2024-12-31)
    const { journalEntries } = await import("../../drizzle/schema.ts");
    const [revRow] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, reopenBody.reversalEntryId)))
      .limit(1);
    expect(revRow?.entryDate.toISOString().slice(0, 10)).toBe("2024-12-31");

    // Post missed adjusting expense (1,000) into reopened FY 2024
    const adjJe = await app.inject({
      method: "POST",
      url: "/api/accounting/journal-entries",
      headers: adminHeaders,
      payload: {
        entryDate: "2024-12-20",
        memo: "Late auditor utility accrual",
        lines: [
          { accountId: expId, debit: 1000, credit: 0 },
          { accountId: cashId, debit: 0, credit: 1000 },
        ],
      },
    });
    expect(adjJe.statusCode).toBe(201);

    // Re-close FY 2024 -> updated Net Income = 6,000, all periods re-closed
    const close2 = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/close`,
      headers: adminHeaders,
      payload: { memo: "Final audited close FY 2024" },
    });
    expect(close2.statusCode).toBe(200);
    expect(close2.json().netIncomeTransferred).toBe(6000);
    expect(close2.json().periodsClosed).toBe(12);

    // Verify Balance Sheet Retained Earnings equals 6,000 and is balanced
    const bs2024 = (
      await app.inject({
        method: "GET",
        url: "/api/accounting/reports/balance-sheet?asOfDate=2024-12-31T23:59:59.999Z",
        headers: adminHeaders,
      })
    ).json();
    expect(bs2024.isBalanced).toBe(true);
    expect(
      (bs2024.equity as Array<{ code: string; balance: number }>).find((e) => e.code === "3105")?.balance
    ).toBe(6000);

    // Verify audit-log hash chain remains 100% intact!
    const verifyRes = await app.inject({
      method: "GET",
      url: "/api/audit-logs/verify",
      headers: adminHeaders,
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().valid).toBe(true);
    expect(verifyRes.json().firstBrokenId).toBeNull();
  });
});
