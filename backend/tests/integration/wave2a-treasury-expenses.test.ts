import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
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

function extractCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const match = list.find((c) => c.startsWith("erp_session="));
  return match ? match.split(";")[0]! : "";
}

function extractCsrfToken(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const match = list.find((c) => c.startsWith("erp_csrf="));
  if (!match) return "";
  return decodeURIComponent(match.split(";")[0]!.slice("erp_csrf=".length));
}

function authHeaders(sessionCookie: string, csrfToken: string): Record<string, string> {
  return {
    cookie: csrfToken ? `${sessionCookie}; erp_csrf=${csrfToken}` : sessionCookie,
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describeWithDb("Wave 2A Integration: Cost Centers, Treasury, Bank Reconciliation & Operating Expenses", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string> = {};
  let secondApproverHeaders: Record<string, string> = {};

  let costCenterMktId = "";
  let costCenterOpsId = "";
  let bankAccountId = "";
  let cashboxAccountId = "";
  let opExAccountId = "";

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
      payload: {
        name: "Wave2A CFO",
        email: "wave2a-admin@test.local",
        password: "AdminPassword123!",
      },
    });
    expect(adminSignup.statusCode).toBe(201);
    adminHeaders = authHeaders(extractCookie(adminSignup), extractCsrfToken(adminSignup));

    // Fetch Chart of Accounts to find 5500 Operating Expenses
    const coaRes = await app.inject({
      method: "GET",
      url: "/api/accounting/accounts",
      headers: adminHeaders,
    });
    expect(coaRes.statusCode).toBe(200);
    const coa = coaRes.json() as { accounts: Array<{ id: string; code: string; accountType: string }> };
    const opEx = coa.accounts.find((a) => a.code === "5500") ?? coa.accounts.find((a) => a.accountType === "expense");
    expect(opEx).toBeDefined();
    opExAccountId = opEx!.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("creates Cost Centers, posts Cost-Center-tagged manual journals, and filters Trial Balance & P&L by Cost Center", async () => {
    const mktRes = await app.inject({
      method: "POST",
      url: "/api/accounting/cost-centers",
      headers: adminHeaders,
      payload: { code: "cc-mkt", name: "Marketing & Growth", description: "Campaigns" },
    });
    expect(mktRes.statusCode).toBe(201);
    costCenterMktId = (mktRes.json() as { costCenter: { id: string; code: string } }).costCenter.id;
    expect((mktRes.json() as { costCenter: { code: string } }).costCenter.code).toBe("CC-MKT");

    const opsRes = await app.inject({
      method: "POST",
      url: "/api/accounting/cost-centers",
      headers: adminHeaders,
      payload: { code: "cc-ops", name: "Store Operations" },
    });
    expect(opsRes.statusCode).toBe(201);
    costCenterOpsId = (opsRes.json() as { costCenter: { id: string } }).costCenter.id;

    // Duplicate code is rejected
    const dupRes = await app.inject({
      method: "POST",
      url: "/api/accounting/cost-centers",
      headers: adminHeaders,
      payload: { code: "CC-MKT", name: "Duplicate" },
    });
    expect(dupRes.statusCode).toBe(409);

    // Post a manual journal entry tagging expense to CC-MKT
    const coaRes = await app.inject({ method: "GET", url: "/api/accounting/accounts", headers: adminHeaders });
    const accounts = (coaRes.json() as { accounts: Array<{ id: string; code: string }> }).accounts;
    const cashGlId = accounts.find((a) => a.code === "1000")!.id;

    const jeRes = await app.inject({
      method: "POST",
      url: "/api/accounting/journal-entries",
      headers: adminHeaders,
      payload: {
        entryDate: "2026-11-15",
        memo: "Billboard campaign",
        lines: [
          { accountId: opExAccountId, costCenterId: costCenterMktId, debit: 400, credit: 0 },
          { accountId: cashGlId, debit: 0, credit: 400 },
        ],
      },
    });
    expect(jeRes.statusCode).toBe(201);

    const pnlMkt = await app.inject({
      method: "GET",
      url: `/api/accounting/reports/profit-loss?costCenterId=${costCenterMktId}`,
      headers: adminHeaders,
    });
    expect(pnlMkt.statusCode).toBe(200);
    expect((pnlMkt.json() as { operatingExpenses: number; netIncome: number }).operatingExpenses).toBe(400);

    const pnlOps = await app.inject({
      method: "GET",
      url: `/api/accounting/reports/profit-loss?costCenterId=${costCenterOpsId}`,
      headers: adminHeaders,
    });
    expect(pnlOps.statusCode).toBe(200);
    expect((pnlOps.json() as { operatingExpenses: number }).operatingExpenses).toBe(0);
  });

  it("creates 1-to-1 GL Bank & Cashbox accounts with opening balances and posts balanced Inter-Account Transfers", async () => {
    const bankRes = await app.inject({
      method: "POST",
      url: "/api/treasury/accounts",
      headers: adminHeaders,
      payload: {
        code: "bnk-cib",
        name: "CIB Corporate Current",
        accountType: "bank",
        bankName: "CIB Egypt",
        accountNumber: "1000998877",
        openingBalance: 10000,
        openingBalanceDate: "2026-11-01",
      },
    });
    expect(bankRes.statusCode).toBe(201);
    const bankDto = (bankRes.json() as { account: { id: string; glAccountCode: string; bookBalance: number } }).account;
    bankAccountId = bankDto.id;
    expect(bankDto.glAccountCode).toMatch(/^10[3-9]\d$/);
    expect(bankDto.bookBalance).toBe(10000);

    const cashboxRes = await app.inject({
      method: "POST",
      url: "/api/treasury/accounts",
      headers: adminHeaders,
      payload: {
        code: "csh-hq",
        name: "HQ Petty Cashbox",
        accountType: "cashbox",
        openingBalance: 500,
        openingBalanceDate: "2026-11-01",
      },
    });
    expect(cashboxRes.statusCode).toBe(201);
    cashboxAccountId = (cashboxRes.json() as { account: { id: string } }).account.id;

    // Transfer 1,200 from CIB Bank -> HQ Petty Cashbox
    const trfRes = await app.inject({
      method: "POST",
      url: "/api/treasury/transfers",
      headers: adminHeaders,
      payload: {
        fromTreasuryAccountId: bankAccountId,
        toTreasuryAccountId: cashboxAccountId,
        amount: 1200,
        transferDate: "2026-11-16",
        reference: "REPL-01",
        memo: "Replenish HQ petty cash",
      },
    });
    expect(trfRes.statusCode).toBe(201);
    expect((trfRes.json() as { transfer: { transferNumber: string } }).transfer.transferNumber).toMatch(/^TRFT-/);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/treasury/accounts",
      headers: adminHeaders,
    });
    const accounts = (listRes.json() as { accounts: Array<{ id: string; bookBalance: number }> }).accounts;
    expect(accounts.find((a) => a.id === bankAccountId)?.bookBalance).toBe(8800);
    expect(accounts.find((a) => a.id === cashboxAccountId)?.bookBalance).toBe(1700);
  });

  it("imports CSV bank statements idempotently, suggests matches, reconciles GL lines & 1-click bank fees, and supports unmatch/ignore", async () => {
    const csvText = [
      "date,description,reference,amount,balance",
      "2026-11-01,Opening Deposit,INIT,10000.00,10000.00",
      "2026-11-16,Cash Withdrawal Replenishment,REPL-01,-1200.00,8800.00",
      "2026-11-17,Monthly Account Fee,FEE-NOV,-35.00,8765.00",
      "2026-11-18,Informational Memo Zero-Impact Reversal,MEMO-X,-1.00,8764.00",
    ].join("\n");

    const imp1 = await app.inject({
      method: "POST",
      url: `/api/treasury/accounts/${bankAccountId}/statements/import-csv`,
      headers: adminHeaders,
      payload: { fileName: "cib-nov.csv", csvText },
    });
    expect(imp1.statusCode).toBe(201);
    expect(imp1.json()).toMatchObject({ importedLines: 4, skippedDuplicates: 0 });

    // Re-importing the exact same CSV skips all 4 duplicate rows via SHA-256 fingerprint
    const imp2 = await app.inject({
      method: "POST",
      url: `/api/treasury/accounts/${bankAccountId}/statements/import-csv`,
      headers: adminHeaders,
      payload: { fileName: "cib-nov-copy.csv", csvText },
    });
    expect(imp2.statusCode).toBe(201);
    expect(imp2.json()).toMatchObject({ importedLines: 0, skippedDuplicates: 4 });

    // Load reconciliation workspace
    const reconViewRes = await app.inject({
      method: "GET",
      url: `/api/treasury/accounts/${bankAccountId}/reconciliation`,
      headers: adminHeaders,
    });
    expect(reconViewRes.statusCode).toBe(200);
    const reconView = reconViewRes.json() as {
      statementLines: Array<{
        id: string;
        amount: number;
        status: string;
        suggestedJournalLineId: string | null;
      }>;
    };
    const withdrawalLine = reconView.statementLines.find((l) => l.amount === -1200)!;
    expect(withdrawalLine.suggestedJournalLineId).toBeTruthy();

    // 1) Reconcile -1200 transfer line against its auto-suggested GL line
    const matchRes = await app.inject({
      method: "POST",
      url: `/api/treasury/statement-lines/${withdrawalLine.id}/reconcile`,
      headers: adminHeaders,
      payload: { journalLineId: withdrawalLine.suggestedJournalLineId },
    });
    expect(matchRes.statusCode).toBe(200);
    expect(matchRes.json()).toMatchObject({
      reconciled: true,
      matchedJournalLineId: withdrawalLine.suggestedJournalLineId,
    });

    // 2) Reconcile -35 bank fee via 1-click adjustment JE tagged to CC-OPS
    const feeLine = reconView.statementLines.find((l) => l.amount === -35)!;
    const adjRes = await app.inject({
      method: "POST",
      url: `/api/treasury/statement-lines/${feeLine.id}/reconcile`,
      headers: adminHeaders,
      payload: {
        createAdjustment: {
          counterpartAccountId: opExAccountId,
          costCenterId: costCenterOpsId,
          memo: "CIB November bank maintenance fee",
        },
      },
    });
    expect(adjRes.statusCode).toBe(200);
    expect((adjRes.json() as { reconciled: boolean }).reconciled).toBe(true);

    // Book balance of bank should now reflect 8800 - 35 = 8765
    const afterAdjAcct = await app.inject({
      method: "GET",
      url: `/api/treasury/accounts/${bankAccountId}/reconciliation`,
      headers: adminHeaders,
    });
    const afterAdjJson = afterAdjAcct.json() as {
      account: { bookBalance: number };
      statementLines: Array<{ id: string; status: string }>;
    };
    expect(afterAdjJson.account.bookBalance).toBe(8765);
    expect(afterAdjJson.statementLines.find((l) => l.id === feeLine.id)?.status).toBe("reconciled");

    // 3) Ignore & un-ignore informational line, and test unreconcile
    const memoLine = reconView.statementLines.find((l) => l.amount === -1)!;
    const ignRes = await app.inject({
      method: "POST",
      url: `/api/treasury/statement-lines/${memoLine.id}/ignore`,
      headers: adminHeaders,
      payload: { ignored: true },
    });
    expect(ignRes.statusCode).toBe(200);
    expect(ignRes.json()).toEqual({ ok: true });

    const unmatchRes = await app.inject({
      method: "POST",
      url: `/api/treasury/statement-lines/${withdrawalLine.id}/unreconcile`,
      headers: adminHeaders,
    });
    expect(unmatchRes.statusCode).toBe(200);
    expect(unmatchRes.json()).toEqual({ ok: true });

    const finalRecon = (
      await app.inject({
        method: "GET",
        url: `/api/treasury/accounts/${bankAccountId}/reconciliation`,
        headers: adminHeaders,
      })
    ).json() as { statementLines: Array<{ id: string; status: string }> };
    expect(finalRecon.statementLines.find((l) => l.id === memoLine.id)?.status).toBe("ignored");
    expect(finalRecon.statementLines.find((l) => l.id === withdrawalLine.id)?.status).toBe("unmatched");
  });

  it("posts Direct Treasury expenses (with Input VAT + Cost Center), accrues & settles Employee Reimbursements, and enforces Maker-Checker when >= 2 approvers exist", async () => {
    // Single-admin bootstrap: self-approval is permitted when only 1 active approver exists
    const directRes = await app.inject({
      method: "POST",
      url: "/api/expenses",
      headers: adminHeaders,
      payload: {
        claimDate: "2026-11-19",
        paymentMode: "direct_treasury",
        treasuryAccountId: cashboxAccountId,
        payeeName: "Cairo Courier Co",
        reference: "RCPT-501",
        submitNow: true,
        lines: [
          {
            expenseAccountId: opExAccountId,
            costCenterId: costCenterOpsId,
            description: "Express parcel dispatch",
            netAmount: 200,
            taxRate: 14,
          },
        ],
      },
    });
    expect(directRes.statusCode).toBe(201);
    const directClaim = (directRes.json() as { claim: { id: string; status: string; subtotal: number; taxTotal: number; totalAmount: number } }).claim;
    expect(directClaim).toMatchObject({
      status: "pending_approval",
      subtotal: 200,
      taxTotal: 28,
      totalAmount: 228,
    });

    const approveDirect = await app.inject({
      method: "POST",
      url: `/api/expenses/${directClaim.id}/review`,
      headers: adminHeaders,
      payload: { decision: "approved", comment: "Verified receipt" },
    });
    expect(approveDirect.statusCode).toBe(200);
    expect((approveDirect.json() as { claim: { status: string; paymentJournalEntryId: string } }).claim.status).toBe("paid");

    // Create a second admin/manager approver to activate strict Maker-Checker self-approval prevention
    const createUserRes = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: adminHeaders,
      payload: {
        name: "Finance Controller",
        email: "wave2a-controller@test.local",
        password: "ControllerPassword123!",
        role: "admin",
        branchScopeMode: "all",
      },
    });
    expect(createUserRes.statusCode).toBe(201);

    const controllerLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "wave2a-controller@test.local", password: "ControllerPassword123!" },
    });
    expect(controllerLogin.statusCode).toBe(200);
    secondApproverHeaders = authHeaders(extractCookie(controllerLogin), extractCsrfToken(controllerLogin));

    // Employee reimbursement submitted by Admin #1
    const reimbRes = await app.inject({
      method: "POST",
      url: "/api/expenses",
      headers: adminHeaders,
      payload: {
        claimDate: "2026-11-20",
        paymentMode: "employee_reimbursement",
        payeeName: "Wave2A CFO",
        reference: "TAXI-77",
        submitNow: true,
        lines: [
          {
            expenseAccountId: opExAccountId,
            costCenterId: costCenterMktId,
            description: "Airport client transport",
            netAmount: 300,
            taxRate: 0,
          },
        ],
      },
    });
    expect(reimbRes.statusCode).toBe(201);
    const reimbId = (reimbRes.json() as { claim: { id: string } }).claim.id;

    // Self-approval by Admin #1 must now be blocked with 403 SELF_APPROVAL_FORBIDDEN
    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/expenses/${reimbId}/review`,
      headers: adminHeaders,
      payload: { decision: "approved" },
    });
    expect(selfApprove.statusCode).toBe(403);

    // Controller approves -> accrues Cr 2400 Employee Reimbursements Payable, status = approved
    const controllerApprove = await app.inject({
      method: "POST",
      url: `/api/expenses/${reimbId}/review`,
      headers: secondApproverHeaders,
      payload: { decision: "approved", comment: "Approved travel claim" },
    });
    expect(controllerApprove.statusCode).toBe(200);
    expect((controllerApprove.json() as { claim: { status: string; accrualJournalEntryId: string } }).claim.status).toBe("approved");

    // Settle reimbursement from CIB Bank -> Dr 2400 / Cr CIB Bank GL, status = paid
    const payRes = await app.inject({
      method: "POST",
      url: `/api/expenses/${reimbId}/pay`,
      headers: secondApproverHeaders,
      payload: { treasuryAccountId: bankAccountId, paymentDate: "2026-11-20", reference: "WIRE-REIMB-1" },
    });
    expect(payRes.statusCode).toBe(200);
    expect((payRes.json() as { claim: { status: string; paymentJournalEntryId: string } }).claim.status).toBe("paid");

    // Verify global Trial Balance remains strictly balanced!
    const tbRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      headers: adminHeaders,
    });
    expect(tbRes.statusCode).toBe(200);
    const tb = tbRes.json() as { isBalanced: boolean; totalDebit: number; totalCredit: number };
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebit).toBeGreaterThan(0);
    expect(Math.abs(tb.totalDebit - tb.totalCredit)).toBeLessThanOrEqual(0.01);
  });
});
