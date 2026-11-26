#!/usr/bin/env node
/**
 * Seeds a full sample year of multi-module ERP & treasury activity into an
 * isolated scratch database (TEST_DATABASE_URL) and prints every generated
 * journal entry alongside the Trial Balance, Profit & Loss, Balance Sheet,
 * Indirect Cash Flow Statement, and VAT Return Summary for hand-checking.
 *
 * Usage:
 *   npm run demo:ledger
 *   TEST_DATABASE_URL="postgresql://..." node scripts/demo-ledger.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const backendEnvPath = path.resolve(repoRoot, "backend/.env");

function readEnvFileVar(filePath, key) {
  if (!fs.existsSync(filePath)) return "";
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`));
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return "";
}

const stripQuotes = (value) => (value ?? "").trim().replace(/^['"]|['"]$/g, "");
const devDbUrlFromFile = readEnvFileVar(backendEnvPath, "DATABASE_URL");

dotenv.config({ path: backendEnvPath });

const targetDbUrl = stripQuotes(process.env.TEST_DATABASE_URL || process.env.DEMO_DATABASE_URL);
if (!targetDbUrl) {
  console.error(
    "ERROR: TEST_DATABASE_URL (or DEMO_DATABASE_URL) must point to a scratch database.\n" +
      "Run via `npm run demo:ledger` to start the ephemeral local Postgres 18 test container automatically."
  );
  process.exit(1);
}

if (devDbUrlFromFile && targetDbUrl === devDbUrlFromFile) {
  console.error("REFUSING TO RUN: target scratch DB URL matches dev DATABASE_URL in backend/.env.");
  process.exit(1);
}

process.env.DATABASE_URL = targetDbUrl;
process.env.TEST_DATABASE_URL = targetDbUrl;
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

const unregisterTsx = register();

function extractCookie(res, name = "erp_session") {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const prefix = `${name}=`;
  const match = list.find((c) => c.startsWith(prefix));
  return match ? match.split(";")[0] : "";
}

function authHeaders(res) {
  const sessionCookie = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrfToken = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrfToken ? `${sessionCookie}; erp_csrf=${csrfToken}` : sessionCookie,
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  };
}

const fmt = (n) => Number(n ?? 0).toFixed(2);

async function injectJson(app, method, url, headers, payload) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload } : {}),
  });
  if (res.statusCode >= 400) {
    throw new Error(`${method} ${url} failed with HTTP ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

async function main() {
  const { buildApp } = await import("../backend/src/app.ts");
  const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");
  const { runMigrations } = await import("../backend/src/db/migrate.ts");
  const { assertTestDatabaseName, resetTestDatabase } = await import(
    "../backend/tests/helpers/db-reset.ts"
  );

  const db = getDb();
  console.error("[demo:ledger] Checking database target...");
  await assertTestDatabaseName(db, targetDbUrl);
  console.error("[demo:ledger] Applying Drizzle migrations...");
  await runMigrations(targetDbUrl);
  console.error("[demo:ledger] Resetting & seeding scratch database...");
  await resetTestDatabase(db);
  console.error("[demo:ledger] Seeding FY sample activity...");

  const app = await buildApp({ logger: false });
  const year = new Date().getUTCFullYear();
  const y = (mmdd) => `${year}-${mmdd}`;

  try {
    // 1. Bootstrap CFO (first user -> admin) + Controller (for Maker-Checker expense approval)
    console.error("[demo:ledger] 1/10 Bootstrapping users & COA...");
    const cfoSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "Demo CFO", email: "cfo@demo.local", password: "DemoPassword123!" },
    });
    assert.equal(cfoSignup.statusCode, 201);
    const cfoUserId = cfoSignup.json().user.id;
    const cfoHeaders = authHeaders(cfoSignup);

    await injectJson(app, "POST", "/api/users", cfoHeaders, {
      name: "Demo Controller",
      email: "controller@demo.local",
      password: "DemoPassword123!",
      role: "admin",
      branchScopeMode: "all",
    });
    const ctrlLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "controller@demo.local", password: "DemoPassword123!" },
    });
    assert.equal(ctrlLogin.statusCode, 200);
    const ctrlHeaders = authHeaders(ctrlLogin);

    await injectJson(app, "PUT", `/api/users/${cfoUserId}/pos-pin`, cfoHeaders, { pin: "2468" });

    // Configure company base currency to EGP for Egypt single-company demo
    await injectJson(app, "PUT", "/api/settings/company", cfoHeaders, {
      baseCurrency: "EGP",
    });
    await injectJson(app, "PUT", "/api/currencies", cfoHeaders, {
      code: "EGP",
      name: "Egyptian Pound",
      symbol: "EGP",
      decimals: 2,
      isBase: true,
      isActive: true,
    });

    const { branches } = await injectJson(app, "GET", "/api/branches", cfoHeaders);
    const hqBranchId = branches[0].id;

    const { accounts: coaList } = await injectJson(
      app,
      "GET",
      "/api/accounting/accounts",
      cfoHeaders
    );
    const acctByCode = new Map(coaList.map((a) => [a.code, a]));
    const opExId = acctByCode.get("5500").id;

    // 2. Cost Centers
    const { costCenter: ccOps } = await injectJson(
      app,
      "POST",
      "/api/accounting/cost-centers",
      cfoHeaders,
      { code: "OPS", name: "Operations" }
    );

    // 3. Treasury Accounts + Opening Balances + Inter-Account Transfer
    console.error("[demo:ledger] 3/10 Seeding Treasury & Transfer...");
    const { account: bnkMain } = await injectJson(app, "POST", "/api/treasury/accounts", cfoHeaders, {
      code: "BNK-MAIN",
      name: "Main Operating Bank",
      accountType: "bank",
      currency: "EGP",
      openingBalance: 50000,
      openingBalanceDate: y("01-02"),
    });
    const { account: cshHq } = await injectJson(app, "POST", "/api/treasury/accounts", cfoHeaders, {
      code: "CSH-HQ",
      name: "HQ Petty Cashbox",
      accountType: "cashbox",
      currency: "EGP",
      openingBalance: 2000,
      openingBalanceDate: y("01-02"),
    });
    await injectJson(app, "POST", "/api/treasury/transfers", cfoHeaders, {
      fromTreasuryAccountId: bnkMain.id,
      toTreasuryAccountId: cshHq.id,
      amount: 1500,
      transferDate: y("01-10"),
      reference: "REPL-01",
      memo: "Replenish HQ petty cashbox",
    });

    // 4. Fixed Assets: CapEx, Monthly Depreciation, Asset Disposal
    console.error("[demo:ledger] 4/10 Seeding Fixed Assets, Depreciation & Disposal...");
    await injectJson(app, "POST", "/api/fixed-assets", cfoHeaders, {
      name: "Delivery Van",
      category: "Vehicles",
      branchId: hqBranchId,
      costCenterId: ccOps.id,
      acquisitionDate: y("01-15"),
      acquisitionCost: 12000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      depreciationMethod: "straight_line",
      fundingAccountId: bnkMain.glAccountId,
    });
    const { asset: fa2 } = await injectJson(app, "POST", "/api/fixed-assets", cfoHeaders, {
      name: "Warehouse Pallet Jack",
      category: "Equipment",
      branchId: hqBranchId,
      costCenterId: ccOps.id,
      acquisitionDate: y("01-15"),
      acquisitionCost: 1200,
      salvageValue: 0,
      usefulLifeMonths: 12,
      depreciationMethod: "straight_line",
      fundingAccountId: bnkMain.glAccountId,
    });
    await injectJson(app, "POST", "/api/fixed-assets/depreciate", cfoHeaders, {
      periodKey: y("01"),
      postingDate: y("01-31"),
    });
    // Dispose FA-2 (NBV 1,100) for 1,250 -> +150 Gain on Disposal (5710)
    await injectJson(app, "POST", `/api/fixed-assets/${fa2.id}/dispose`, cfoHeaders, {
      disposalDate: y("06-15"),
      proceedsAmount: 1250,
      depositAccountId: bnkMain.glAccountId,
      notes: "Sold pallet jack at gain",
    });

    // 5. Inventory, Purchasing, Vendor Bill, Purchase Return & Payment Made
    console.error("[demo:ledger] 5/10 Seeding Purchasing, Bill, Return & Payment Made...");
    const { product } = await injectJson(app, "POST", "/api/products", cfoHeaders, {
      sku: "WIDGET-PRO",
      name: "Industrial Widget Pro",
      costPrice: 50,
      sellingPrice: 100,
      initialStock: [],
    });
    const { vendor } = await injectJson(app, "POST", "/api/vendors", cfoHeaders, {
      name: "Apex Manufacturing Co",
    });
    const { receive } = await injectJson(app, "POST", "/api/purchase-receives", cfoHeaders, {
      vendorId: vendor.id,
      branchId: hqBranchId,
      receiveDate: y("02-01"),
      lines: [{ productId: product.id, quantity: 100, unitCost: 50 }],
    });
    const { bill } = await injectJson(app, "POST", "/api/vendor-bills", cfoHeaders, {
      vendorId: vendor.id,
      branchId: hqBranchId,
      receiveId: receive.id,
      billDate: y("02-05"),
      dueDate: y("03-05"),
      lines: [{ productId: product.id, description: "Widget Pro batch", quantity: 100, unitCost: 50, taxRate: 14 }],
    });
    await injectJson(app, "POST", "/api/purchase-returns", cfoHeaders, {
      vendorId: vendor.id,
      branchId: hqBranchId,
      receiveId: receive.id,
      billId: bill.id,
      returnDate: y("02-12"),
      reason: "Damaged units",
      lines: [{ productId: product.id, quantity: 5, unitCost: 50, taxRate: 14 }],
    });
    // Pay net balance after return: 5,700 - 285 = 5,415
    await injectJson(app, "POST", "/api/payments-made", cfoHeaders, {
      vendorId: vendor.id,
      branchId: hqBranchId,
      paymentDate: y("02-20"),
      amount: 5415,
      paymentMethod: "bank",
      allocations: [{ billId: bill.id, amount: 5415 }],
    });

    // 6. Sales Invoice, Sales Return (+ Credit Application) & Customer Receipt
    console.error("[demo:ledger] 6/10 Seeding Sales Invoice, Sales Return & Receipt...");
    const { customer } = await injectJson(app, "POST", "/api/customers", cfoHeaders, {
      name: "Delta Retail Group",
    });
    const { invoice: inv1 } = await injectJson(app, "POST", "/api/sales-invoices", cfoHeaders, {
      customerId: customer.id,
      branchId: hqBranchId,
      status: "Sent",
      invoiceDate: y("03-10"),
      dueDate: y("04-10"),
      lines: [{ productId: product.id, description: "Widget Pro wholesale", quantity: 40, unitPrice: 100, taxRate: 14 }],
    });
    const { salesReturn: sret1 } = await injectJson(app, "POST", "/api/sales-returns", cfoHeaders, {
      customerId: customer.id,
      branchId: hqBranchId,
      invoiceId: inv1.id,
      returnDate: y("03-20"),
      reason: "Excess shipment returned",
      restockItems: true,
      lines: [{ productId: product.id, quantity: 2, unitPrice: 100, taxRate: 14 }],
    });
    await injectJson(app, "POST", `/api/sales-returns/${sret1.id}/apply`, cfoHeaders, {
      invoiceId: inv1.id,
      amount: 228,
    });
    // Collect remaining 4,560 - 228 = 4,332
    await injectJson(app, "POST", "/api/received-payments", cfoHeaders, {
      customerId: customer.id,
      branchId: hqBranchId,
      paymentDate: y("03-25"),
      amount: 4332,
      paymentMethod: "bank",
      allocations: [{ invoiceId: inv1.id, amount: 4332 }],
    });

    // 7. Operating Expenses (Direct Treasury + Accrued & Paid Employee Reimbursement)
    console.error("[demo:ledger] 7/10 Seeding Direct & Reimbursement Expenses...");
    const { claim: directExp } = await injectJson(app, "POST", "/api/expenses", cfoHeaders, {
      claimDate: y("05-10"),
      paymentMode: "direct_treasury",
      treasuryAccountId: cshHq.id,
      payeeName: "City Courier",
      reference: "RCPT-101",
      submitNow: true,
      lines: [
        {
          expenseAccountId: opExId,
          costCenterId: ccOps.id,
          description: "Courier & postage",
          netAmount: 200,
          taxRate: 14,
        },
      ],
    });
    await injectJson(app, "POST", `/api/expenses/${directExp.id}/review`, ctrlHeaders, {
      decision: "approved",
      comment: "Approved direct petty cash expense",
    });

    const { claim: reimbExp } = await injectJson(app, "POST", "/api/expenses", cfoHeaders, {
      claimDate: y("05-15"),
      paymentMode: "employee_reimbursement",
      payeeName: "Demo CFO",
      reference: "TRVL-88",
      submitNow: true,
      lines: [
        {
          expenseAccountId: opExId,
          costCenterId: ccOps.id,
          description: "Regional customer visit",
          netAmount: 300,
          taxRate: 0,
        },
      ],
    });
    await injectJson(app, "POST", `/api/expenses/${reimbExp.id}/review`, ctrlHeaders, {
      decision: "approved",
      comment: "Approved travel claim",
    });
    await injectJson(app, "POST", `/api/expenses/${reimbExp.id}/pay`, ctrlHeaders, {
      treasuryAccountId: bnkMain.id,
      paymentDate: y("05-20"),
      reference: "WIRE-REIMB-01",
    });

    // 8. POS Shift, Checkout (Cash + Card), Partial Cash Return & Shift Close with $5 Shortage
    console.error("[demo:ledger] 8/10 Seeding POS Checkout, Return & Shift Close...");
    const { terminal } = await injectJson(app, "POST", "/api/pos/terminals", cfoHeaders, {
      branchId: hqBranchId,
      code: "REG-DEMO",
      name: "Demo Counter POS",
    });
    const { shift } = await injectJson(app, "POST", "/api/pos/shifts/open", cfoHeaders, {
      terminalId: terminal.id,
      openingFloat: 100,
    });
    const { receipt: posSale } = await injectJson(app, "POST", "/api/pos/checkout", cfoHeaders, {
      terminalId: terminal.id,
      shiftId: shift.id,
      currency: "EGP",
      offlineCreatedAt: `${year}-07-15T12:00:00Z`,
      lines: [{ productId: product.id, quantity: 5, unitPrice: 100, taxRate: 14 }],
      tenders: [
        { method: "cash", amount: 300, tenderedAmount: 300 },
        { method: "card", amount: 270 },
      ],
    });
    const posDetail = await injectJson(app, "GET", `/api/pos/receipts/${posSale.id}`, cfoHeaders);
    await injectJson(app, "POST", "/api/pos/returns", cfoHeaders, {
      originalInvoiceId: posSale.id,
      terminalId: terminal.id,
      shiftId: shift.id,
      refundMethod: "cash",
      restockItems: true,
      reason: "Customer changed mind",
      managerOverridePin: "2468",
      lines: [{ originalInvoiceLineId: posDetail.receipt.lines[0].id, productId: product.id, quantity: 1 }],
    });
    // Expected cash = 100 + 300 - 114 = 286; report 281 => 5 EGP shortage
    await injectJson(app, "POST", `/api/pos/shifts/${shift.id}/close`, cfoHeaders, {
      countedCash: 281,
      notes: "Sample shift close with 5 EGP cash shortage",
    });

    // 9. Bank Reconciliation Fee (-35 EGP)
    console.error("[demo:ledger] 9/10 Seeding Bank Reconciliation Fee...");
    const stmtCsv = [
      "date,description,reference,amount,balance",
      `${y("11-17")},Monthly Bank Account Fee,FEE-NOV,-35.00,37715.00`,
    ].join("\n");
    await injectJson(
      app,
      "POST",
      `/api/treasury/accounts/${bnkMain.id}/statements/import-csv`,
      cfoHeaders,
      { fileName: "demo-bank.csv", csvText: stmtCsv }
    );
    const reconView = await injectJson(
      app,
      "GET",
      `/api/treasury/accounts/${bnkMain.id}/reconciliation`,
      cfoHeaders
    );
    const feeLine = reconView.statementLines[0];
    await injectJson(
      app,
      "POST",
      `/api/treasury/statement-lines/${feeLine.id}/reconcile`,
      cfoHeaders,
      {
        createAdjustment: {
          counterpartAccountId: opExId,
          costCenterId: ccOps.id,
          memo: "Monthly bank maintenance fee",
        },
      }
    );

    // 10. Multi-Currency AR + Period-End FX Revaluation & Auto-Reversal + Realized FX Settlement
    console.error("[demo:ledger] 10/10 Seeding Multi-Currency FX Revaluation & Settlement...");
    await injectJson(app, "PUT", "/api/currencies", cfoHeaders, {
      code: "EUR",
      name: "Euro",
      symbol: "€",
      decimals: 2,
      isBase: false,
      isActive: true,
    });
    await injectJson(app, "POST", "/api/currencies/rates", cfoHeaders, {
      fromCurrency: "EUR",
      toCurrency: "EGP",
      rate: 1.2,
      effectiveAt: `${year}-11-28T12:00:00Z`,
    });
    const { customer: eurCustomer } = await injectJson(app, "POST", "/api/customers", cfoHeaders, {
      name: "Euro Client GmbH",
      currency: "EUR",
    });
    const { invoice: eurInv } = await injectJson(app, "POST", "/api/sales-invoices", cfoHeaders, {
      customerId: eurCustomer.id,
      branchId: hqBranchId,
      status: "Sent",
      invoiceDate: y("11-10"),
      dueDate: y("12-20"),
      currency: "EUR",
      fxRate: 1.1,
      lines: [{ description: "Export consulting retainer", quantity: 1, unitPrice: 1000, taxRate: 14 }],
    });
    // Month-end revaluation (1.20 vs 1.10 -> +114.00 unrealized FX gain, auto-reversed 12-01)
    await injectJson(app, "POST", "/api/accounting/fx-revaluation", cfoHeaders, {
      asOfDate: y("11-30"),
      autoReverse: true,
    });
    // Settle 1,140 EUR at 1.25 -> +171.00 realized FX gain (5600)
    await injectJson(app, "POST", "/api/received-payments", cfoHeaders, {
      customerId: eurCustomer.id,
      branchId: hqBranchId,
      paymentDate: y("12-05"),
      amount: 1140,
      currency: "EUR",
      fxRate: 1.25,
      allocations: [{ invoiceId: eurInv.id, amount: 1140 }],
    });

    // Query Journal Entries + Pre-Close Financial Statements
    console.error("[demo:ledger] Querying financial statements & VAT return...");
    const fromDate = `${year}-01-01`;
    const toDate = `${year}-12-31T23:59:59.999Z`;

    const [{ entries }, tb, pnl, bs, cf, vat, reconciliation, setupHealth, fyData] = await Promise.all([
      injectJson(app, "GET", "/api/accounting/journal-entries?pageSize=100", cfoHeaders),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/trial-balance?fromDate=${fromDate}&toDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/profit-loss?fromDate=${fromDate}&toDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/balance-sheet?asOfDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/cash-flow?fromDate=${fromDate}&toDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/vat-return?fromDate=${fromDate}&toDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/reconciliation?asOfDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(app, "GET", "/api/accounting/setup-health", cfoHeaders),
      injectJson(app, "GET", "/api/accounting/fiscal-years", cfoHeaders),
    ]);

    const currentFy = fyData.fiscalYears.find((f) => f.name === `FY ${year}`);
    assert.ok(currentFy, `Expected fiscal year FY ${year} to exist`);
    const closeResult = await injectJson(
      app,
      "POST",
      `/api/accounting/fiscal-years/${currentFy.id}/close`,
      cfoHeaders,
      { memo: `Year-end close for FY ${year}` }
    );

    const [{ entries: entriesAfterClose }, tbPostClose, bsPostClose] = await Promise.all([
      injectJson(app, "GET", "/api/accounting/journal-entries?pageSize=100", cfoHeaders),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/trial-balance?fromDate=${fromDate}&toDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
      injectJson(
        app,
        "GET",
        `/api/accounting/reports/balance-sheet?asOfDate=${encodeURIComponent(toDate)}`,
        cfoHeaders
      ),
    ]);

    const acctLabelById = new Map(coaList.map((a) => [a.id, `${a.code} ${a.name}`]));
    // Re-fetch COA because Treasury accounts auto-created 1030 / 1031
    const { accounts: fullCoa } = await injectJson(
      app,
      "GET",
      "/api/accounting/accounts",
      cfoHeaders
    );
    for (const a of fullCoa) acctLabelById.set(a.id, `${a.code} ${a.name}`);

    console.log("================================================================================");
    console.log(`COUNT IT, KEEP IT — ACCOUNTANT DEMO LEDGER (FY ${year}, EGP, SCRATCH DB)`);
    console.log("================================================================================\n");

    console.log("## 1. POSTED JOURNAL ENTRIES (CHRONOLOGICAL)\n");
    const chronological = [...entriesAfterClose].reverse();
    for (const je of chronological) {
      console.log(
        `[${je.entryDate.slice(0, 10)}] ${je.entryNumber} (${je.sourceType}) Ref=${je.referenceNumber} — ${je.memo}`
      );
      for (const line of je.lines) {
        const label = acctLabelById.get(line.accountId) ?? line.accountId;
        const side = line.debitBase > 0 ? `DR ${fmt(line.debitBase)}` : `CR ${fmt(line.creditBase)}`;
        console.log(`    ${side.padEnd(14)} | ${label}`);
      }
    }

    console.log("\n## 2. PRE-CLOSE TRIAL BALANCE (FY " + year + ")\n");
    console.log("Code  | Account Name                              |      Debit |     Credit |   Net (Dr-Cr)");
    console.log("------+-------------------------------------------+------------+------------+--------------");
    for (const r of tb.rows) {
      if (r.debit === 0 && r.credit === 0) continue;
      const net = r.closingDebit > 0 ? r.closingDebit : -r.closingCredit;
      console.log(
        `${r.code.padEnd(5)} | ${r.name.slice(0, 41).padEnd(41)} | ${fmt(r.debit).padStart(10)} | ${fmt(r.credit).padStart(10)} | ${fmt(net).padStart(12)}`
      );
    }
    console.log(
      `TOTAL | Balanced=${String(tb.isBalanced).padEnd(32)} | ${fmt(tb.totalDebit).padStart(10)} | ${fmt(tb.totalCredit).padStart(10)} |`
    );

    console.log("\n## 3. PROFIT & LOSS STATEMENT (FY " + year + ")\n");
    for (const r of pnl.revenueAccounts) {
      if (r.balance !== 0) console.log(`Revenue  | ${r.code} ${r.name.padEnd(38)} : ${fmt(r.balance).padStart(10)}`);
    }
    console.log(`Total Revenue                                         : ${fmt(pnl.totalRevenue).padStart(10)}`);
    console.log(`Cost of Goods Sold (5000)                             : ${fmt(pnl.cogsTotal).padStart(10)}`);
    console.log(`Gross Profit                                          : ${fmt(pnl.grossProfit).padStart(10)}`);
    for (const r of pnl.expenseAccounts) {
      if (r.code !== "5000" && r.balance !== 0) {
        console.log(`Expense  | ${r.code} ${r.name.padEnd(38)} : ${fmt(r.balance).padStart(10)}`);
      }
    }
    console.log(`Total Operating Expenses                              : ${fmt(pnl.operatingExpenses).padStart(10)}`);
    console.log(`Net Income                                            : ${fmt(pnl.netIncome).padStart(10)}`);

    console.log("\n## 4. BALANCE SHEET (AS OF " + y("12-31") + ", PRE-CLOSE)\n");
    for (const a of bs.assets) {
      if (a.balance !== 0) console.log(`Asset    | ${a.code} ${a.name.padEnd(38)} : ${fmt(a.balance).padStart(10)}`);
    }
    console.log(`Total Assets                                          : ${fmt(bs.totalAssets).padStart(10)}`);
    for (const l of bs.liabilities) {
      if (l.balance !== 0) console.log(`Liab     | ${l.code} ${l.name.padEnd(38)} : ${fmt(l.balance).padStart(10)}`);
    }
    console.log(`Total Liabilities                                     : ${fmt(bs.totalLiabilities).padStart(10)}`);
    for (const e of bs.equity) {
      if (e.balance !== 0) console.log(`Equity   | ${e.code} ${e.name.padEnd(38)} : ${fmt(e.balance).padStart(10)}`);
    }
    console.log(`Current Year Earnings                                 : ${fmt(bs.currentYearEarnings).padStart(10)}`);
    console.log(`Total Equity                                          : ${fmt(bs.totalEquity).padStart(10)}`);
    console.log(
      `Total Liabilities & Equity (Balanced=${bs.isBalanced})        : ${fmt(bs.totalLiabilitiesAndEquity).padStart(10)}`
    );

    console.log("\n## 5. INDIRECT CASH FLOW STATEMENT (FY " + year + ")\n");
    console.log(`Operating Net Income                                  : ${fmt(cf.operating.netIncome).padStart(10)}`);
    for (const item of cf.operating.nonCashAdjustments) {
      console.log(`  Non-Cash | ${item.code} ${item.label.padEnd(36)} : ${fmt(item.amount).padStart(10)}`);
    }
    for (const item of cf.operating.workingCapitalChanges) {
      console.log(`  WC Change| ${item.code} ${item.label.slice(0, 36).padEnd(36)} : ${fmt(item.amount).padStart(10)}`);
    }
    console.log(`Net Cash from Operating Activities                    : ${fmt(cf.operating.total).padStart(10)}`);
    for (const item of cf.investing.items) {
      console.log(`  Investing| ${item.code} ${item.label.slice(0, 36).padEnd(36)} : ${fmt(item.amount).padStart(10)}`);
    }
    console.log(`Net Cash from Investing Activities                    : ${fmt(cf.investing.total).padStart(10)}`);
    for (const item of cf.financing.items) {
      console.log(`  Financing| ${item.code} ${item.label.slice(0, 36).padEnd(36)} : ${fmt(item.amount).padStart(10)}`);
    }
    console.log(`Net Cash from Financing Activities                    : ${fmt(cf.financing.total).padStart(10)}`);
    console.log(`Opening Cash                                          : ${fmt(cf.openingCash).padStart(10)}`);
    console.log(`Net Change in Cash                                    : ${fmt(cf.netCashChange).padStart(10)}`);
    console.log(`Closing Cash (Reconciled=${cf.isReconciled})                        : ${fmt(cf.closingCash).padStart(10)}`);

    console.log("\n## 6. VAT RETURN SUMMARY (FY " + year + ")\n");
    for (const b of vat.outputSales) {
      console.log(
        `Output VAT @ ${String(b.taxRate).padStart(5)}% | Taxable=${fmt(b.taxableAmount).padStart(10)} | VAT=${fmt(b.vatAmount).padStart(10)} | Docs=${b.documentCount}`
      );
    }
    for (const b of vat.inputPurchasesAndExpenses) {
      console.log(
        `Input  VAT @ ${String(b.taxRate).padStart(5)}% | Taxable=${fmt(b.taxableAmount).padStart(10)} | VAT=${fmt(b.vatAmount).padStart(10)} | Docs=${b.documentCount}`
      );
    }
    console.log(`Total Output VAT (Subledger / GL 2300)                : ${fmt(vat.totalOutputVat)} / ${fmt(vat.glOutputVatBalance)}`);
    console.log(`Total Input VAT  (Subledger / GL 1300)                : ${fmt(vat.totalInputVat)} / ${fmt(vat.glInputVatBalance)}`);
    console.log(`Net VAT Payable  (Subledger / GL)                     : ${fmt(vat.netVatPayable)} / ${fmt(vat.glNetVatPayable)}`);

    console.log("\n## 7. SUBLEDGER-TO-GL CONTROL RECONCILIATION (EGP)\n");
    console.log("Control Account                               |  Subledger |         GL |   Variance | OK");
    console.log("----------------------------------------------+------------+------------+------------+------");
    for (const item of reconciliation.items) {
      console.log(
        `${item.label.slice(0, 45).padEnd(45)} | ${fmt(item.subledgerBalance).padStart(10)} | ${fmt(item.glBalance).padStart(10)} | ${fmt(item.variance).padStart(10)} | ${item.isReconciled}`
      );
    }
    console.log(`All Subledgers Reconciled=${reconciliation.allReconciled} | Setup Health=${setupHealth.healthy} (${setupHealth.validMappings}/${setupHealth.totalMappings})`);

    console.log("\n## 8. YEAR-END CLOSE RESULT & POST-CLOSE CHECK (EGP)\n");
    console.log(
      `Closing Entry=${closeResult.entryNumber} | Revenue Closed=${fmt(closeResult.totalRevenueClosed)} EGP | Expenses Closed=${fmt(closeResult.totalExpensesClosed)} EGP | Net Income -> 3100=${fmt(closeResult.netIncomeTransferred)} EGP`
    );
    console.log(
      `Post-Close TB Balanced=${tbPostClose.isBalanced} (Dr=${fmt(tbPostClose.totalDebit)} EGP, Cr=${fmt(tbPostClose.totalCredit)} EGP) | Post-Close BS Balanced=${bsPostClose.isBalanced} | 3100 Retained Earnings=${fmt(bsPostClose.equity.find((e) => e.code === "3100")?.balance ?? 0)} EGP | Current Year Earnings=${fmt(bsPostClose.currentYearEarnings)} EGP`
    );

    assert.equal(tb.isBalanced, true, "Pre-close Trial Balance must balance");
    assert.equal(bs.isBalanced, true, "Pre-close Balance Sheet must balance");
    assert.equal(cf.isReconciled, true, "Cash Flow statement must reconcile");
    assert.ok(
      Math.abs(vat.totalOutputVat - vat.glOutputVatBalance) <= 0.01,
      `Output VAT subledger (${vat.totalOutputVat}) must equal GL 2300 (${vat.glOutputVatBalance})`
    );
    assert.ok(
      Math.abs(vat.totalInputVat - vat.glInputVatBalance) <= 0.01,
      `Input VAT subledger (${vat.totalInputVat}) must equal GL 1300 (${vat.glInputVatBalance})`
    );
    assert.ok(
      Math.abs(vat.netVatPayable - vat.glNetVatPayable) <= 0.01,
      `Net VAT payable subledger (${vat.netVatPayable}) must equal GL (${vat.glNetVatPayable})`
    );
    assert.equal(
      reconciliation.allReconciled,
      true,
      `All subledger-to-GL controls must reconcile: ${JSON.stringify(reconciliation.items.filter((i) => !i.isReconciled))}`
    );
    assert.equal(setupHealth.healthy, true, "Accounting setup health must be healthy");
    assert.equal(tbPostClose.isBalanced, true, "Post-close Trial Balance must balance");
    assert.equal(bsPostClose.isBalanced, true, "Post-close Balance Sheet must balance");
    assert.equal(entries.length + 1, entriesAfterClose.length, "Year-end close appends 1 closing JE");
  } finally {
    await app.close();
    await closeDatabase();
    unregisterTsx();
  }
}

main().catch((err) => {
  console.error("demo:ledger failed:", err);
  process.exit(1);
});
