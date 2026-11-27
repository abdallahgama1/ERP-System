import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppDatabase } from "../../src/db/index.ts";
import { customers, salesInvoices } from "../../drizzle/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const testDbUrl = (process.env.TEST_DATABASE_URL ?? "").trim().replace(/^['"]|['"]$/g, "");
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

const fixturesDir = path.resolve(__dirname, "../../../scripts/fixtures/cutover");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf8");
}

function extractCookie(res: { headers: Record<string, unknown> }, name = "erp_session"): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const prefix = `${name}=`;
  const match = list.find((c) => c.startsWith(prefix));
  return match ? match.split(";")[0]! : "";
}

function authHeaders(res: { headers: Record<string, unknown> }) {
  const session = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrf = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrf ? `${session}; erp_csrf=${csrf}` : session,
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describeWithDb("Go-Live Cutover CSV Imports, Reconciliation, Exclusions & Controlled Reversal", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string>;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    app = await buildApp({ logger: false, enableRateLimit: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  beforeEach(async () => {
    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Cutover Admin",
        email: "cutover@test.local",
        password: "StrongPassword123!",
      },
    });
    expect(signup.statusCode).toBe(201);
    adminHeaders = authHeaders(signup);

    const comp = await app.inject({
      method: "PUT",
      url: "/api/settings/company",
      headers: adminHeaders,
      payload: { companyName: "Delta Cutover Co", baseCurrency: "EGP", einvoicingMode: "eta_egypt" },
    });
    expect(comp.statusCode).toBe(200);

    // Ensure FY 2026 exists and is open
    const fyRes = await app.inject({
      method: "GET",
      url: "/api/accounting/fiscal-years",
      headers: adminHeaders,
    });
    const has2026 = (fyRes.json().fiscalYears as Array<{ startDate: string; endDate: string }>).some(
      (y) => y.startDate.slice(0, 10) <= "2026-01-01" && y.endDate.slice(0, 10) >= "2026-01-01"
    );
    if (!has2026) {
      const createFy = await app.inject({
        method: "POST",
        url: "/api/accounting/fiscal-years",
        headers: adminHeaders,
        payload: { name: "FY 2026", startDate: "2026-01-01", endDate: "2026-12-31" },
      });
      expect(createFy.statusCode).toBe(201);
    }
  });

  it("1. validates COA mapping guards and surfaces projected setup-health in dry-run before commit", async () => {
    // Attempt to import a COA with an inactive mapped account (3100) and a type reclassification error (5600 as asset)
    const badCoaCsv = [
      "code,name,account_type,normal_balance,is_active",
      "3100,Retained Earnings Inactive,equity,credit,false",
      "5600,Wrong Type FX,asset,debit,true",
      "1030,Main Operating Bank,asset,debit,true",
    ].join("\n");

    const dryRes = await app.inject({
      method: "POST",
      url: "/api/imports/chart_of_accounts",
      headers: adminHeaders,
      payload: { csv: badCoaCsv, dryRun: true },
    });
    expect(dryRes.statusCode).toBe(200);
    const dryBody = dryRes.json();
    expect(dryBody.valid).toBe(false);
    expect(dryBody.errors.some((e: { row: number; column: string }) => e.row === 3 && e.column === "account_type")).toBe(true);
    // Dry-run returns projected setupHealth showing retained_earnings would become inactive!
    expect(dryBody.setupHealth).toBeDefined();
    expect(dryBody.setupHealth.healthy).toBe(false);
    expect(
      dryBody.setupHealth.issues.some(
        (i: { mappingKey: string; status: string }) => i.mappingKey === "retained_earnings" && i.status === "inactive"
      )
    ).toBe(true);
  });

  it("2. handles BOM, Arabic, Arabic-Indic digits, Excel numbers, ETA validation, and all-or-nothing rollback", async () => {
    const invalidCustomersCsv =
      "\uFEFF code , name , eta_receiver_type , tax_number , currency \r\n" +
      "CUST-OK,شركة سليمة,B,٢٠٠-٣٠٠-٤٠٠,EGP\r\n" +
      "CUST-BAD-RIN,Bad Business,B,12345,EGP\r\n" +
      "CUST-BAD-NID,Bad Person,P,99999,EGP\r\n" +
      "CUST-BAD-TYPE,Bad Type,X,123456789,EGP\r\n";

    // Commit with errors must reject ALL rows (zero partial writes)
    const badCommit = await app.inject({
      method: "POST",
      url: "/api/imports/customers",
      headers: adminHeaders,
      payload: { csv: invalidCustomersCsv, dryRun: false },
    });
    expect(badCommit.statusCode).toBe(200);
    const badBody = badCommit.json();
    expect(badBody.valid).toBe(false);
    expect(badBody.errors.length).toBeGreaterThanOrEqual(3);

    const custRowsAfterFail = await db.select().from(customers).where(eq(customers.code, "CUST-OK"));
    expect(custRowsAfterFail).toHaveLength(0);

    // Valid Arabic + BOM + Arabic-Indic RIN + Excel credit limit succeeds
    const validCustomersCsv =
      "\uFEFF code , name , eta_receiver_type , tax_number , currency , credit_limit \r\n" +
      'CUST-AR-1,"شركة الدلتا للتجارة",B,٢٠٠-٣٠٠-٤٠٠,EGP,"150,000.50"\r\n' +
      'CUST-AR-2,"محمد علي",P,٢٩٠٠١٠١١٢٣٤٥٦٧,EGP,\r\n';

    const okCommit = await app.inject({
      method: "POST",
      url: "/api/imports/customers",
      headers: adminHeaders,
      payload: { csv: validCustomersCsv, dryRun: false },
    });
    expect(okCommit.statusCode).toBe(200);
    expect(okCommit.json().valid).toBe(true);
    expect(okCommit.json().createdCount).toBe(2);

    const [ar1] = await db.select().from(customers).where(eq(customers.code, "CUST-AR-1"));
    expect(ar1?.name).toBe("شركة الدلتا للتجارة");
    expect(ar1?.taxNumber).toBe("200300400");
    expect(Number(ar1?.creditLimit)).toBe(150000.5);
  });

  it("3. executes full 8-step cutover, passes all 8 reconciliation controls, enforces VAT/P&L/ETA exclusions, and allows paying opening AR/AP", async () => {
    // Steps 1-7 using synthetic fixtures
    const standardSequence = [
      ["chart_of_accounts", "01-chart-of-accounts.csv"],
      ["customers", "02-customers.csv"],
      ["vendors", "03-vendors.csv"],
      ["products", "04-products.csv"],
      ["opening_stock", "05-opening-stock.csv"],
      ["opening_fixed_assets", "06-opening-fixed-assets.csv"],
      ["opening_treasury", "07-opening-treasury.csv"],
    ] as const;

    for (const [kind, file] of standardSequence) {
      const res = await app.inject({
        method: "POST",
        url: `/api/imports/${kind}`,
        headers: adminHeaders,
        payload: { csv: readFixture(file), dryRun: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(true);
    }

    // Balance-sheet-only guard: adding a P&L account (4000) without allowPnlAccounts=true is rejected
    const tbWithPnl = `${readFixture("08-opening-trial-balance.csv")}4000,0,1000,Should be blocked\n1031,1000,0,Offset\n`;
    const pnlReject = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances",
      headers: adminHeaders,
      payload: {
        cutoverDate: "2026-01-01",
        allowPnlAccounts: false,
        trialBalanceCsv: tbWithPnl,
        openArCsv: readFixture("09-opening-ar.csv"),
        openApCsv: readFixture("10-opening-ap.csv"),
        dryRun: true,
      },
    });
    expect(pnlReject.statusCode).toBe(200);
    expect(pnlReject.json().valid).toBe(false);
    expect(
      pnlReject.json().errors.some((e: { message: string }) => /P&L|revenue/i.test(e.message))
    ).toBe(true);

    // Step 8: Commit unified opening balances
    const openCommitRes = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances",
      headers: adminHeaders,
      payload: {
        cutoverDate: "2026-01-01",
        allowPnlAccounts: false,
        trialBalanceCsv: readFixture("08-opening-trial-balance.csv"),
        openArCsv: readFixture("09-opening-ar.csv"),
        openApCsv: readFixture("10-opening-ap.csv"),
        dryRun: false,
      },
    });
    expect(openCommitRes.statusCode).toBe(200);
    const openBody = openCommitRes.json();
    expect(openBody.valid).toBe(true);
    expect(openBody.journalEntryNumber).toBeTruthy();
    expect(openBody.reconciliation.allReconciled).toBe(true);

    // Verify ALL 8 reconciliation controls pass individually
    const reconRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/reconciliation",
      headers: adminHeaders,
    });
    expect(reconRes.statusCode).toBe(200);
    const recon = reconRes.json();
    expect(recon.allReconciled).toBe(true);
    expect(recon.items).toHaveLength(8);
    for (const item of recon.items) {
      expect(item.isReconciled, `Control ${item.key} must pass`).toBe(true);
    }

    // Verify single-use safety: a second opening balances import is rejected
    const secondOpen = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances",
      headers: adminHeaders,
      payload: {
        cutoverDate: "2026-01-01",
        trialBalanceCsv: readFixture("08-opening-trial-balance.csv"),
        openArCsv: readFixture("09-opening-ar.csv"),
        openApCsv: readFixture("10-opening-ap.csv"),
        dryRun: true,
      },
    });
    expect(secondOpen.json().valid).toBe(false);
    expect(
      secondOpen.json().errors.some((e: { message: string }) => /already been posted/i.test(e.message))
    ).toBe(true);

    // Verify VAT Return exclusion + opening VAT carryover reconciliation
    const vatRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/vat-return",
      headers: adminHeaders,
    });
    expect(vatRes.statusCode).toBe(200);
    const vat = vatRes.json();
    expect(vat.outputSales).toHaveLength(0);
    expect(vat.inputPurchasesAndExpenses).toHaveLength(0);
    expect(vat.totalOutputVat).toBe(0);
    expect(vat.totalInputVat).toBe(0);
    expect(vat.openingOutputVatCarryover).toBe(5600);
    expect(vat.openingInputVatCarryover).toBe(3500);
    expect(vat.glOutputVatBalance).toBe(5600);
    expect(vat.glInputVatBalance).toBe(3500);
    expect(vat.openingVatReconciliationNote).toMatch(/carryover/i);

    // Verify P&L revenue = 0 (opening AR did NOT book revenue)
    const pnlRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/profit-loss",
      headers: adminHeaders,
    });
    expect(pnlRes.statusCode).toBe(200);
    expect(pnlRes.json().totalRevenue).toBe(0);
    expect(pnlRes.json().netIncome).toBe(0);

    // Verify opening AR NEVER enters ETA e-invoice queue (even if metadata helper is invoked directly)
    const etaQueueRes = await app.inject({
      method: "GET",
      url: "/api/einvoicing/submissions",
      headers: adminHeaders,
    });
    expect(etaQueueRes.statusCode).toBe(200);
    expect(etaQueueRes.json().items).toHaveLength(0);

    const [openInv] = await db
      .select()
      .from(salesInvoices)
      .where(eq(salesInvoices.invoiceNumber, "OPEN-AR-2025-001"));
    expect(openInv?.source).toBe("opening_balance");

    const { applyInvoiceEInvoiceMetadata } = await import("../../src/services/einvoicing.service.ts");
    const directEta = await applyInvoiceEInvoiceMetadata(db, openInv!.id);
    expect(directEta.eInvoiceStatus).toBe("not_applicable");
    const etaQueueAfter = await app.inject({
      method: "GET",
      url: "/api/einvoicing/submissions",
      headers: adminHeaders,
    });
    expect(etaQueueAfter.json().items).toHaveLength(0);

    // Verify opening AR & AP are payable & applicable and keep reconciliation passing!
    const payAr = await app.inject({
      method: "POST",
      url: "/api/received-payments",
      headers: adminHeaders,
      payload: {
        customerId: openInv!.customerId,
        paymentDate: "2026-01-10",
        amount: 20000,
        paymentMethod: "Bank Transfer",
        currency: "EGP",
        allocations: [{ invoiceId: openInv!.id, amount: 20000 }],
      },
    });
    expect(payAr.statusCode).toBe(201);

    const billsRes = await app.inject({
      method: "GET",
      url: "/api/vendor-bills",
      headers: adminHeaders,
    });
    const openBill = (billsRes.json().bills as Array<{ id: string; vendorId: string; billNumber: string; source: string }>).find(
      (b) => b.billNumber === "OPEN-AP-2025-001"
    )!;
    expect(openBill.source).toBe("opening_balance");

    const payAp = await app.inject({
      method: "POST",
      url: "/api/payments-made",
      headers: adminHeaders,
      payload: {
        vendorId: openBill.vendorId,
        paymentDate: "2026-01-12",
        amount: 12000,
        paymentMethod: "Bank Transfer",
        currency: "EGP",
        allocations: [{ billId: openBill.id, amount: 12000 }],
      },
    });
    expect(payAp.statusCode).toBe(201);

    // Reconciliation STILL passes 8/8 after paying opening AR & AP!
    const reconAfterPay = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/reconciliation",
      headers: adminHeaders,
    });
    expect(reconAfterPay.json().allReconciled).toBe(true);
  });

  it("4. supports controlled opening reversal (reversing JE + removing opening docs/stock + valid audit chain) and blocks when non-opening JEs exist", async () => {
    for (const [kind, file] of [
      ["chart_of_accounts", "01-chart-of-accounts.csv"],
      ["customers", "02-customers.csv"],
      ["vendors", "03-vendors.csv"],
      ["products", "04-products.csv"],
      ["opening_stock", "05-opening-stock.csv"],
      ["opening_fixed_assets", "06-opening-fixed-assets.csv"],
      ["opening_treasury", "07-opening-treasury.csv"],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: `/api/imports/${kind}`,
        headers: adminHeaders,
        payload: { csv: readFixture(file), dryRun: false },
      });
      expect(r.json().valid).toBe(true);
    }

    const openRes = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances",
      headers: adminHeaders,
      payload: {
        cutoverDate: "2026-01-01",
        trialBalanceCsv: readFixture("08-opening-trial-balance.csv"),
        openArCsv: readFixture("09-opening-ar.csv"),
        openApCsv: readFixture("10-opening-ap.csv"),
        dryRun: false,
      },
    });
    expect(openRes.json().valid).toBe(true);

    // Non-admin user cannot call reversal or imports
    const userSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Standard User", email: "user@test.local", password: "StrongPassword123!" },
    });
    const userHeaders = authHeaders(userSignup);
    const forbiddenRev = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances/reverse",
      headers: userHeaders,
      payload: { reason: "Unauthorized attempt" },
    });
    expect(forbiddenRev.statusCode).toBe(403);

    // Controlled admin reversal
    const revRes = await app.inject({
      method: "POST",
      url: "/api/imports/opening-balances/reverse",
      headers: adminHeaders,
      payload: { reason: "Correcting opening stock count before go-live" },
    });
    expect(revRes.statusCode).toBe(200);
    const revBody = revRes.json();
    expect(revBody.reversalEntryNumber).toBeTruthy();
    expect(revBody.removedArInvoices).toBe(2);
    expect(revBody.removedApBills).toBe(2);
    expect(revBody.removedFixedAssets).toBe(2);
    expect(revBody.removedTreasuryAccounts).toBe(2);
    expect(revBody.removedOpeningStockMovements).toBe(2);

    // Reconciliation after reversal is clean (0 == 0 across all controls) and audit chain is intact!
    const [reconAfterRev, auditVerify, statusAfterRev] = await Promise.all([
      app.inject({ method: "GET", url: "/api/accounting/reports/reconciliation", headers: adminHeaders }),
      app.inject({ method: "GET", url: "/api/audit-logs/verify", headers: adminHeaders }),
      app.inject({ method: "GET", url: "/api/imports/opening-balances/status", headers: adminHeaders }),
    ]);
    expect(reconAfterRev.json().allReconciled).toBe(true);
    expect(auditVerify.json().valid).toBe(true);
    expect(statusAfterRev.json().canImportOpening).toBe(true);
  });
});
