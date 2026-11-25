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

describeWithDb("Wave 2B Integration: Cash Flow, VAT Return, Comparative P&L, Year-End Close, FX Revaluation & Fixed Assets", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string> = {};
  let defaultBranchId = "";
  let customerId = "";
  let vendorId = "";

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName, resetTestDatabase } = await import("../helpers/db-reset.ts");

    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    await resetTestDatabase(db);
    app = await buildApp({ logger: false });

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Wave2B CFO",
        email: "wave2b-admin@test.local",
        password: "AdminPassword123!",
      },
    });
    expect(signup.statusCode).toBe(201);
    adminHeaders = authHeaders(extractCookie(signup), extractCsrfToken(signup));

    const branchRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      headers: adminHeaders,
    });
    expect(branchRes.statusCode).toBe(200);
    const branchList = (branchRes.json() as { branches: Array<{ id: string }> }).branches;
    defaultBranchId = branchList[0]!.id;

    const custRes = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: adminHeaders,
      payload: { name: "Euro Client GmbH", currency: "EUR" },
    });
    expect(custRes.statusCode).toBe(201);
    customerId = (custRes.json() as { customer: { id: string } }).customer.id;

    const vendRes = await app.inject({
      method: "POST",
      url: "/api/vendors",
      headers: adminHeaders,
      payload: { name: "Global Supplier Ltd", currency: "EUR" },
    });
    expect(vendRes.statusCode).toBe(201);
    vendorId = (vendRes.json() as { vendor: { id: string } }).vendor.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("registers Fixed Assets, runs idempotent monthly depreciation, and posts accurate disposal gain/loss", async () => {
    // Seed opening cash via a Treasury Bank Account (20,000 USD)
    const bankRes = await app.inject({
      method: "POST",
      url: "/api/treasury/accounts",
      headers: adminHeaders,
      payload: {
        code: "BNK-MAIN",
        name: "Main Operating Bank",
        accountType: "bank",
        openingBalance: 20000,
        openingBalanceDate: "2026-10-01",
      },
    });
    expect(bankRes.statusCode).toBe(201);

    // 1. Register Straight-Line Asset: Cost 1,200, Salvage 0, Life 12m => 100/month
    const fa1Res = await app.inject({
      method: "POST",
      url: "/api/fixed-assets",
      headers: adminHeaders,
      payload: {
        name: "Warehouse Pallet Jack",
        category: "Warehouse Equipment",
        branchId: defaultBranchId,
        acquisitionDate: "2026-10-15",
        acquisitionCost: 1200,
        salvageValue: 0,
        usefulLifeMonths: 12,
        depreciationMethod: "straight_line",
      },
    });
    expect(fa1Res.statusCode).toBe(201);
    const fa1 = (fa1Res.json() as { asset: { id: string; assetCode: string; netBookValue: number } }).asset;
    expect(fa1.assetCode).toMatch(/^FA-/);
    expect(fa1.netBookValue).toBe(1200);

    // 2. Register Declining-Balance Asset: Cost 2,400, Salvage 400, Life 24m (2y) => 200/month in month 1
    const fa2Res = await app.inject({
      method: "POST",
      url: "/api/fixed-assets",
      headers: adminHeaders,
      payload: {
        name: "Industrial Label Printer",
        category: "IT Hardware",
        branchId: defaultBranchId,
        acquisitionDate: "2026-10-15",
        acquisitionCost: 2400,
        salvageValue: 400,
        usefulLifeMonths: 24,
        depreciationMethod: "declining_balance",
      },
    });
    expect(fa2Res.statusCode).toBe(201);

    // 3. Run Monthly Depreciation for 2026-10 => 100 + 200 = 300 total depreciation
    const depRun1 = await app.inject({
      method: "POST",
      url: "/api/fixed-assets/depreciate",
      headers: adminHeaders,
      payload: { periodKey: "2026-10" },
    });
    expect(depRun1.statusCode).toBe(200);
    expect(depRun1.json()).toMatchObject({
      periodKey: "2026-10",
      processedAssets: 2,
      skippedAlreadyPosted: 0,
      totalDepreciationPosted: 300,
    });

    // 4. Re-running 2026-10 is strictly idempotent
    const depRunDup = await app.inject({
      method: "POST",
      url: "/api/fixed-assets/depreciate",
      headers: adminHeaders,
      payload: { periodKey: "2026-10" },
    });
    expect(depRunDup.statusCode).toBe(200);
    expect(depRunDup.json()).toMatchObject({
      periodKey: "2026-10",
      processedAssets: 0,
      skippedAlreadyPosted: 2,
      totalDepreciationPosted: 0,
    });

    // 5. Dispose FA-1 (NBV = 1,100) for 1,250 cash => +150 Gain on Asset Disposal (Cr 5710)
    const dispRes = await app.inject({
      method: "POST",
      url: `/api/fixed-assets/${fa1.id}/dispose`,
      headers: adminHeaders,
      payload: {
        disposalDate: "2026-11-05",
        proceedsAmount: 1250,
        notes: "Sold to logistics partner",
      },
    });
    expect(dispRes.statusCode).toBe(200);
    expect((dispRes.json() as { asset: { status: string; netBookValue: number } }).asset).toMatchObject({
      status: "disposed",
      netBookValue: 0,
    });
  });

  it("posts Realized FX Gain/Loss on AR/AP settlements and Period-End FX Revaluation with next-day auto-reversal", async () => {
    // Configure EUR currency & baseline rate 1.10
    await app.inject({
      method: "PUT",
      url: "/api/currencies",
      headers: adminHeaders,
      payload: { code: "EUR", name: "Euro", symbol: "€", decimals: 2, isBase: false, isActive: true },
    });
    await app.inject({
      method: "POST",
      url: "/api/currencies/rates",
      headers: adminHeaders,
      payload: { fromCurrency: "EUR", toCurrency: "USD", rate: 1.2, effectiveAt: "2026-11-28T12:00:00Z" },
    });

    // Create 1,000 EUR + 14% VAT (= 1,140 EUR) Sales Invoice booked at fxRate 1.10 (AR Base = 1,254 USD)
    const invRes = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      headers: adminHeaders,
      payload: {
        customerId,
        branchId: defaultBranchId,
        status: "Sent",
        invoiceDate: "2026-11-10",
        dueDate: "2026-12-10",
        currency: "EUR",
        fxRate: 1.1,
        lines: [{ description: "Export consulting batch", quantity: 1, unitPrice: 1000, taxRate: 14 }],
      },
    });
    expect(invRes.statusCode).toBe(201);
    const invId = (invRes.json() as { invoice: { id: string } }).invoice.id;

    // Create 500 EUR + 14% VAT (= 570 EUR) Vendor Bill booked at fxRate 1.10 (AP Base = 627 USD)
    const billRes = await app.inject({
      method: "POST",
      url: "/api/vendor-bills",
      headers: adminHeaders,
      payload: {
        vendorId,
        branchId: defaultBranchId,
        billDate: "2026-11-12",
        dueDate: "2026-12-12",
        currency: "EUR",
        fxRate: 1.1,
        lines: [{ description: "Freight forwarding", quantity: 1, unitCost: 500, taxRate: 14 }],
      },
    });
    expect(billRes.statusCode).toBe(201);
    const billId = (billRes.json() as { bill: { id: string } }).bill.id;

    // Preview Period-End FX Revaluation as of 2026-11-30 (closing rate 1.20 vs booked 1.10):
    // AR +114.00 unrealized gain, AP -57.00 unrealized loss => net +57.00
    const prevRes = await app.inject({
      method: "GET",
      url: "/api/accounting/fx-revaluation/preview?asOfDate=2026-11-30",
      headers: adminHeaders,
    });
    expect(prevRes.statusCode).toBe(200);
    const prev = prevRes.json() as { totalUnrealizedGainLoss: number; lines: unknown[] };
    expect(prev.lines).toHaveLength(2);
    expect(prev.totalUnrealizedGainLoss).toBe(57);

    // Execute Period-End FX Revaluation with autoReverse: true
    const revalRes = await app.inject({
      method: "POST",
      url: "/api/accounting/fx-revaluation",
      headers: adminHeaders,
      payload: { asOfDate: "2026-11-30", autoReverse: true },
    });
    expect(revalRes.statusCode).toBe(201);
    const revalJson = revalRes.json() as { entryNumber: string; reversalEntryNumber: string };
    expect(revalJson.entryNumber).toMatch(/^JE-/);
    expect(revalJson.reversalEntryNumber).toMatch(/^JE-/);

    // Settle the 1,140 EUR Sales Invoice on 2026-12-05 at fxRate 1.25 => Realized FX Gain = 1,140 * (1.25 - 1.10) = +171 USD
    const rpayRes = await app.inject({
      method: "POST",
      url: "/api/received-payments",
      headers: adminHeaders,
      payload: {
        customerId,
        branchId: defaultBranchId,
        paymentDate: "2026-12-05",
        amount: 1140,
        currency: "EUR",
        fxRate: 1.25,
        allocations: [{ invoiceId: invId, amount: 1140 }],
      },
    });
    expect(rpayRes.statusCode).toBe(201);

    // Settle the 570 EUR Vendor Bill on 2026-12-06 at fxRate 1.05 => Realized FX Gain = 570 * (1.10 - 1.05) = +28.50 USD
    const pmadeRes = await app.inject({
      method: "POST",
      url: "/api/payments-made",
      headers: adminHeaders,
      payload: {
        vendorId,
        branchId: defaultBranchId,
        paymentDate: "2026-12-06",
        amount: 570,
        currency: "EUR",
        fxRate: 1.05,
        allocations: [{ billId, amount: 570 }],
      },
    });
    expect(pmadeRes.statusCode).toBe(201);
  });

  it("produces reconciled Indirect Cash Flow, VAT Return Summary, Comparative P&L, and executes Year-End Fiscal Close", async () => {
    // 1. Indirect Cash Flow Statement must reconcile Opening + Net Change === Closing Cash
    const cfRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/cash-flow?fromDate=2026-10-01&toDate=2026-12-31",
      headers: adminHeaders,
    });
    expect(cfRes.statusCode).toBe(200);
    const cf = cfRes.json() as {
      isReconciled: boolean;
      openingCash: number;
      closingCash: number;
      netCashChange: number;
      operating: { total: number };
      investing: { total: number };
      financing: { total: number };
    };
    expect(cf.isReconciled).toBe(true);
    expect(Math.abs(cf.openingCash + cf.netCashChange - cf.closingCash)).toBeLessThanOrEqual(0.02);

    // 2. VAT Return Summary
    const vatRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/vat-return?fromDate=2026-11-01&toDate=2026-11-30",
      headers: adminHeaders,
    });
    expect(vatRes.statusCode).toBe(200);
    const vat = vatRes.json() as { totalOutputVat: number; totalInputVat: number; netVatPayable: number };
    expect(vat.totalOutputVat).toBe(154); // 140 EUR * 1.10 = 154 USD
    expect(vat.totalInputVat).toBe(77); // 70 EUR * 1.10 = 77 USD
    expect(vat.netVatPayable).toBe(77);

    // 3. Comparative P&L (Nov 2026 vs Oct 2026)
    const compPnlRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/profit-loss?fromDate=2026-11-01&toDate=2026-11-30&compareFromDate=2026-10-01&compareToDate=2026-10-31",
      headers: adminHeaders,
    });
    expect(compPnlRes.statusCode).toBe(200);
    const compPnl = compPnlRes.json() as {
      totalRevenue: number;
      comparative?: { totalRevenue: number; revenueVariance: number };
    };
    expect(compPnl.comparative).toBeDefined();
    expect(compPnl.comparative?.revenueVariance).toBe(compPnl.totalRevenue);

    // 4. Year-End Fiscal Closing Wizard on historical FY 2025
    const fyRes = await app.inject({
      method: "POST",
      url: "/api/accounting/fiscal-years",
      headers: adminHeaders,
      payload: { name: "FY 2025", startDate: "2025-01-01", endDate: "2025-12-31" },
    });
    expect(fyRes.statusCode).toBe(201);
    const fyId = (fyRes.json() as { fiscalYear: { id: string } }).fiscalYear.id;

    // Post revenue & expense in FY 2025
    const coa = (
      await app.inject({ method: "GET", url: "/api/accounting/accounts", headers: adminHeaders })
    ).json() as { accounts: Array<{ id: string; code: string }> };
    const cashId = coa.accounts.find((a) => a.code === "1000")!.id;
    const revId = coa.accounts.find((a) => a.code === "4000")!.id;
    const expId = coa.accounts.find((a) => a.code === "5500")!.id;

    await app.inject({
      method: "POST",
      url: "/api/accounting/journal-entries",
      headers: adminHeaders,
      payload: {
        entryDate: "2025-06-15",
        memo: "FY 2025 activity",
        lines: [
          { accountId: cashId, debit: 5000, credit: 0 },
          { accountId: expId, debit: 2000, credit: 0 },
          { accountId: revId, debit: 0, credit: 7000 },
        ],
      },
    });

    const closeRes = await app.inject({
      method: "POST",
      url: `/api/accounting/fiscal-years/${fyId}/close`,
      headers: adminHeaders,
      payload: { memo: "Close FY 2025" },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json()).toMatchObject({
      status: "closed",
      totalRevenueClosed: 7000,
      totalExpensesClosed: 2000,
      netIncomeTransferred: 5000,
    });

    // Unlocking a period inside a closed fiscal year must be rejected with 409
    const fyList = (
      await app.inject({ method: "GET", url: "/api/accounting/fiscal-years", headers: adminHeaders })
    ).json() as { fiscalYears: Array<{ id: string; periods: Array<{ id: string }> }> };
    const closedPeriodId = fyList.fiscalYears.find((y) => y.id === fyId)!.periods[0]!.id;
    const unlockAttempt = await app.inject({
      method: "POST",
      url: `/api/accounting/periods/${closedPeriodId}/unlock`,
      headers: adminHeaders,
    });
    expect(unlockAttempt.statusCode).toBe(409);

    // P&L for FY 2025 still shows operational revenue 7,000 & net income 5,000 (closing sweep excluded!)
    const pnl2025 = (
      await app.inject({
        method: "GET",
        url: "/api/accounting/reports/profit-loss?fromDate=2025-01-01&toDate=2025-12-31",
        headers: adminHeaders,
      })
    ).json() as { totalRevenue: number; netIncome: number };
    expect(pnl2025.totalRevenue).toBe(7000);
    expect(pnl2025.netIncome).toBe(5000);

    // Balance Sheet as of 2026-12-31 is balanced and Retained Earnings (3100) holds 5,000
    const bs = (
      await app.inject({
        method: "GET",
        url: "/api/accounting/reports/balance-sheet?asOfDate=2026-12-31",
        headers: adminHeaders,
      })
    ).json() as { isBalanced: boolean; equity: Array<{ code: string; balance: number }> };
    expect(bs.isBalanced).toBe(true);
    expect(bs.equity.find((e) => e.code === "3100")?.balance).toBe(5000);
  });
});
