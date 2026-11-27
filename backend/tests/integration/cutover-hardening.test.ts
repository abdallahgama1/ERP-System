import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../../src/db/index.ts";
import {
  auditLogs,
  bankStatementLines,
  bankStatements,
  branchProducts,
  branches,
  chartOfAccounts,
  creditNoteApplications,
  customers,
  expenseClaims,
  fixedAssets,
  journalLines,
  posReturns,
  posShifts,
  posTerminals,
  products,
  purchaseReturns,
  retainerApplications,
  retainerInvoices,
  salesInvoices,
  salesReturns,
  treasuryAccounts,
  vendorBills,
  vendors,
} from "../../drizzle/schema.ts";

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

describeWithDb("Cutover Hardening: Reversal Blockers, Re-Import Semantics, 10k Benchmark & Readiness Gate", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string>;
  let adminUserId: string;

  async function seedFullCutover() {
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
      expect(r.statusCode, `step ${kind} HTTP`).toBe(200);
      expect(r.json().valid, `step ${kind} valid`).toBe(true);
    }

    const openRes = await app.inject({
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
    expect(openRes.statusCode).toBe(200);
    expect(openRes.json().valid).toBe(true);
    return openRes.json();
  }

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    app = await buildApp({ logger: false, enableRateLimit: false });
  });

  afterAll(async () => {
    delete process.env.CSV_IMPORT_MAX_ROWS;
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  beforeEach(async () => {
    delete process.env.CSV_IMPORT_MAX_ROWS;
    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Hardening Admin",
        email: "hardening@test.local",
        password: "StrongPassword123!",
      },
    });
    expect(signup.statusCode).toBe(201);
    adminHeaders = authHeaders(signup);
    adminUserId = signup.json().user.id;

    const comp = await app.inject({
      method: "PUT",
      url: "/api/settings/company",
      headers: adminHeaders,
      payload: { companyName: "Hardening Cutover Co", baseCurrency: "EGP", einvoicingMode: "eta_egypt" },
    });
    expect(comp.statusCode).toBe(200);

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

  describe("1. Opening-balance reversal blockers (all 6 categories + full blocker listing)", () => {
    it("1a. blocks reversal when a non-opening journal entry exists in or after the cutover period", async () => {
      await seedFullCutover();
      const coaRows = await db.select().from(chartOfAccounts);
      const bank = coaRows.find((a) => a.code === "1030")!;
      const exp = coaRows.find((a) => a.code === "5200") ?? coaRows.find((a) => a.accountType === "expense")!;

      const jeRes = await app.inject({
        method: "POST",
        url: "/api/accounting/journal-entries",
        headers: adminHeaders,
        payload: {
          entryDate: "2026-01-05",
          memo: "Post-cutover office supplies",
          lines: [
            { accountId: exp.id, debit: 500, credit: 0 },
            { accountId: bank.id, debit: 0, credit: 500 },
          ],
        },
      });
      expect(jeRes.statusCode).toBe(201);
      const jeNumber = jeRes.json().entry.entryNumber;

      const revRes = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempted reversal after manual JE" },
      });
      expect(revRes.statusCode).toBe(409);
      const body = revRes.json();
      expect(body.code).toBe("OPENING_REVERSAL_BLOCKED");
      expect(body.message).toContain(jeNumber);
      const blockers = body.details?.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(blockers.some((b) => b.category === "non_opening_journal" && b.reference === jeNumber)).toBe(true);
      // Also lists the opening treasury account touched by the JE!
      expect(blockers.some((b) => b.category === "opening_treasury" && b.reference === "BNK-CIB-SYN")).toBe(true);
    });

    it("1b. blocks reversal when opening AR invoice has payment allocation, credit note/sales return, retainer application, or POS return", async () => {
      await seedFullCutover();
      const [openInv] = await db
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.invoiceNumber, "OPEN-AR-2025-001"));
      expect(openInv).toBeDefined();

      // Case i: Real payment allocation via API
      const payRes = await app.inject({
        method: "POST",
        url: "/api/received-payments",
        headers: adminHeaders,
        payload: {
          customerId: openInv!.customerId,
          paymentDate: "2026-01-10",
          amount: 5000,
          paymentMethod: "Bank Transfer",
          currency: "EGP",
          allocations: [{ invoiceId: openInv!.id, amount: 5000 }],
        },
      });
      expect(payRes.statusCode).toBe(201);

      const revAfterPay = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempt reversal after AR payment" },
      });
      expect(revAfterPay.statusCode).toBe(409);
      expect(revAfterPay.json().code).toBe("OPENING_REVERSAL_BLOCKED");
      const payBlockers = revAfterPay.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(
        payBlockers.some((b) => b.category === "opening_ar" && b.reference === "OPEN-AR-2025-001" && /payment/i.test(b.reason))
      ).toBe(true);

      // Case ii: Credit note / sales return + creditNoteApplication + retainerApplication + POS return directly referencing opening AR invoice
      const [openInv2] = await db
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.invoiceNumber, "OPEN-AR-2025-002"));
      const [hqBranch] = await db.select().from(branches).limit(1);

      const [sr] = await db
        .insert(salesReturns)
        .values({
          returnNumber: "SR-BLOCK-1",
          creditNoteNumber: "CN-BLOCK-1",
          customerId: openInv2!.customerId,
          branchId: hqBranch!.id,
          invoiceId: openInv2!.id,
          totalAmount: "1000",
        })
        .returning();
      await db.insert(creditNoteApplications).values({
        returnId: sr!.id,
        invoiceId: openInv2!.id,
        amount: "1000",
      });
      const [ret] = await db
        .insert(retainerInvoices)
        .values({
          retainerNumber: "RET-BLOCK-1",
          customerId: openInv2!.customerId,
          branchId: hqBranch!.id,
          amount: "500",
        })
        .returning();
      await db.insert(retainerApplications).values({
        retainerId: ret!.id,
        invoiceId: openInv2!.id,
        amount: "500",
      });
      const [term] = await db
        .insert(posTerminals)
        .values({ branchId: hqBranch!.id, code: "POS-T1", name: "Register 1" })
        .returning();
      const [shift] = await db
        .insert(posShifts)
        .values({
          shiftNumber: "SH-1",
          terminalId: term!.id,
          branchId: hqBranch!.id,
          openedByUserId: adminUserId,
        })
        .returning();
      await db.insert(posReturns).values({
        returnNumber: "POSR-BLOCK-1",
        originalInvoiceId: openInv2!.id,
        branchId: hqBranch!.id,
        terminalId: term!.id,
        shiftId: shift!.id,
        cashierUserId: adminUserId,
        refundMethod: "cash",
        totalAmount: "200",
      });

      const revAllAr = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Verify all AR blocker sub-types are listed" },
      });
      expect(revAllAr.statusCode).toBe(409);
      const arBlockers = revAllAr.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(arBlockers.some((b) => b.category === "opening_ar" && /credit note application/i.test(b.reason))).toBe(true);
      expect(arBlockers.some((b) => b.category === "opening_ar" && /retainer application/i.test(b.reason))).toBe(true);
      expect(arBlockers.some((b) => b.category === "opening_ar" && /SR-BLOCK-1/.test(b.reason))).toBe(true);
      expect(arBlockers.some((b) => b.category === "opening_ar" && /POSR-BLOCK-1/.test(b.reason))).toBe(true);
    });

    it("1c. blocks reversal when opening AP bill has payment allocation or purchase return", async () => {
      await seedFullCutover();
      const [openBill] = await db
        .select()
        .from(vendorBills)
        .where(eq(vendorBills.billNumber, "OPEN-AP-2025-001"));
      const [openBill2] = await db
        .select()
        .from(vendorBills)
        .where(eq(vendorBills.billNumber, "OPEN-AP-2025-002"));

      const payAp = await app.inject({
        method: "POST",
        url: "/api/payments-made",
        headers: adminHeaders,
        payload: {
          vendorId: openBill!.vendorId,
          paymentDate: "2026-01-12",
          amount: 4000,
          paymentMethod: "Bank Transfer",
          currency: "EGP",
          allocations: [{ billId: openBill!.id, amount: 4000 }],
        },
      });
      expect(payAp.statusCode).toBe(201);

      await db.insert(purchaseReturns).values({
        returnNumber: "PR-BLOCK-1",
        vendorId: openBill2!.vendorId,
        branchId: openBill2!.branchId,
        billId: openBill2!.id,
        totalAmount: "1500",
      });

      const revRes = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempt reversal after AP payment & return" },
      });
      expect(revRes.statusCode).toBe(409);
      expect(revRes.json().code).toBe("OPENING_REVERSAL_BLOCKED");
      const blockers = revRes.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(
        blockers.some((b) => b.category === "opening_ap" && b.reference === "OPEN-AP-2025-001" && /payment/i.test(b.reason))
      ).toBe(true);
      expect(
        blockers.some((b) => b.category === "opening_ap" && b.reference === "OPEN-AP-2025-002" && /PR-BLOCK-1/.test(b.reason))
      ).toBe(true);
    });

    it("1d. blocks reversal when opening stock has subsequent movements (adjustment) or reserved qty", async () => {
      await seedFullCutover();
      const [prod] = await db.select().from(products).where(eq(products.sku, "SYN-VALVE-01"));
      const [hqBranch] = await db.select().from(branches).limit(1);

      const adjRes = await app.inject({
        method: "POST",
        url: "/api/adjustments",
        headers: adminHeaders,
        payload: {
          branchId: hqBranch!.id,
          reason: "Damaged unit post cutover",
          lines: [{ productId: prod!.id, qtyDelta: -1 }],
        },
      });
      expect(adjRes.statusCode).toBe(201);

      // Also reserve 2 units on the second opening SKU
      const [prod2] = await db.select().from(products).where(eq(products.sku, "SYN-PUMP-02"));
      await db
        .update(branchProducts)
        .set({ qtyReserved: "2" })
        .where(eq(branchProducts.productId, prod2!.id));

      const revRes = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempt reversal after stock moved" },
      });
      expect(revRes.statusCode).toBe(409);
      expect(revRes.json().code).toBe("OPENING_REVERSAL_BLOCKED");
      const blockers = revRes.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(
        blockers.some((b) => b.category === "opening_stock" && b.reference.startsWith("SYN-VALVE-01@") && /subsequent movement/i.test(b.reason))
      ).toBe(true);
      expect(
        blockers.some((b) => b.category === "opening_stock" && b.reference.startsWith("SYN-PUMP-02@") && /reserved quantity/i.test(b.reason))
      ).toBe(true);
    });

    it("1e. blocks reversal when an opening fixed asset has depreciation or disposal entries", async () => {
      await seedFullCutover();

      // Run Jan 2026 depreciation via API
      const depRes = await app.inject({
        method: "POST",
        url: "/api/fixed-assets/depreciate",
        headers: adminHeaders,
        payload: { periodKey: "2026-01", depreciationDate: "2026-01-31" },
      });
      expect(depRes.statusCode).toBe(200);

      // Also dispose the second opening fixed asset via API
      const [fa2] = await db.select().from(fixedAssets).where(eq(fixedAssets.assetCode, "FA-SYN-02"));
      const dispRes = await app.inject({
        method: "POST",
        url: `/api/fixed-assets/${fa2!.id}/dispose`,
        headers: adminHeaders,
        payload: { disposalDate: "2026-01-31", proceeds: 40000, notes: "Sold electric forklift" },
      });
      expect(dispRes.statusCode).toBe(200);

      const revRes = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempt reversal after depreciation & disposal" },
      });
      expect(revRes.statusCode).toBe(409);
      expect(revRes.json().code).toBe("OPENING_REVERSAL_BLOCKED");
      const blockers = revRes.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(
        blockers.some((b) => b.category === "opening_fixed_asset" && b.reference === "FA-SYN-01" && /depreciation/i.test(b.reason))
      ).toBe(true);
      expect(
        blockers.some((b) => b.category === "opening_fixed_asset" && b.reference === "FA-SYN-02" && /disposed/i.test(b.reason))
      ).toBe(true);
    });

    it("1f. blocks reversal when an opening treasury account has transfer, bank statement/reconciliation, or expense claim", async () => {
      await seedFullCutover();
      const trRows = await db.select().from(treasuryAccounts);
      const bank = trRows.find((t) => t.code === "BNK-CIB-SYN")!;
      const cash = trRows.find((t) => t.code === "CSH-HQ-SYN")!;

      // 1. Treasury transfer via API
      const trRes = await app.inject({
        method: "POST",
        url: "/api/treasury/transfers",
        headers: adminHeaders,
        payload: {
          fromTreasuryAccountId: bank.id,
          toTreasuryAccountId: cash.id,
          amount: 10000,
          transferDate: "2026-01-08",
          memo: "Replenish petty cash",
        },
      });
      expect(trRes.statusCode).toBe(201);

      // 2. Imported bank statement + reconciled line on BANK-CIB
      const [stmt] = await db
        .insert(bankStatements)
        .values({
          treasuryAccountId: bank.id,
          statementNumber: "STMT-2026-01",
          fileName: "cib-jan.csv",
          lineCount: 1,
        })
        .returning();
      const [anyJl] = await db.select({ id: journalLines.id }).from(journalLines).limit(1);
      await db.insert(bankStatementLines).values({
        statementId: stmt!.id,
        treasuryAccountId: bank.id,
        lineDate: new Date("2026-01-08T00:00:00.000Z"),
        description: "Transfer out",
        amount: "-10000",
        fingerprint: "fp-block-1",
        status: "reconciled",
        matchedJournalLineId: anyJl!.id,
      });

      // 3. Expense claim referencing CASH-HQ
      await db.insert(expenseClaims).values({
        claimNumber: "EXP-BLOCK-1",
        treasuryAccountId: cash.id,
        status: "draft",
        totalAmount: "250",
        currency: "EGP",
      });

      const revRes = await app.inject({
        method: "POST",
        url: "/api/imports/opening-balances/reverse",
        headers: adminHeaders,
        payload: { reason: "Attempt reversal after treasury activity" },
      });
      expect(revRes.statusCode).toBe(409);
      expect(revRes.json().code).toBe("OPENING_REVERSAL_BLOCKED");
      const blockers = revRes.json().details.blockers as Array<{ category: string; reference: string; reason: string }>;
      expect(blockers.some((b) => b.category === "opening_treasury" && /transfer/i.test(b.reason))).toBe(true);
      expect(blockers.some((b) => b.category === "opening_treasury" && /STMT-2026-01/.test(b.reason))).toBe(true);
      expect(blockers.some((b) => b.category === "opening_treasury" && /reconciled statement/i.test(b.reason))).toBe(true);
      expect(blockers.some((b) => b.category === "opening_treasury" && /EXP-BLOCK-1/.test(b.reason))).toBe(true);
    });
  });

  describe("2. Master-data re-import semantics (default create-only vs explicit updateExisting partial patch)", () => {
    it("2a. rejects duplicate re-uploads by default ('already exists') across COA, Customers, Vendors, and Products", async () => {
      const datasets = [
        ["chart_of_accounts", "01-chart-of-accounts.csv"],
        ["customers", "02-customers.csv"],
        ["vendors", "03-vendors.csv"],
        ["products", "04-products.csv"],
      ] as const;

      for (const [kind, file] of datasets) {
        const csv = readFixture(file);
        // First upload succeeds
        const first = await app.inject({
          method: "POST",
          url: `/api/imports/${kind}`,
          headers: adminHeaders,
          payload: { csv, dryRun: false },
        });
        expect(first.statusCode).toBe(200);
        expect(first.json().valid).toBe(true);
        expect(first.json().createdCount).toBeGreaterThan(0);

        // Second upload of the EXACT same file with default updateExisting=false fails dry-run & commit
        const secondDry = await app.inject({
          method: "POST",
          url: `/api/imports/${kind}`,
          headers: adminHeaders,
          payload: { csv, dryRun: true },
        });
        expect(secondDry.statusCode).toBe(200);
        expect(secondDry.json().valid).toBe(false);
        expect(secondDry.json().errors.length).toBe(first.json().createdCount);
        expect(
          secondDry.json().errors.every((e: { message: string }) => /already exists/i.test(e.message))
        ).toBe(true);

        const secondCommit = await app.inject({
          method: "POST",
          url: `/api/imports/${kind}`,
          headers: adminHeaders,
          payload: { csv, dryRun: false },
        });
        expect(secondCommit.statusCode).toBe(200);
        expect(secondCommit.json().valid).toBe(false);
      }
    });

    it("2b. explicit updateExisting=true updates ONLY listed CSV columns and NEVER touches balances", async () => {
      await seedFullCutover();

      // Snapshot balances BEFORE partial re-imports
      const [bpBefore] = await db
        .select()
        .from(branchProducts)
        .innerJoin(products, eq(branchProducts.productId, products.id))
        .where(eq(products.sku, "SYN-VALVE-01"));
      const [arBefore] = await db
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.invoiceNumber, "OPEN-AR-2025-001"));
      const [coaBefore] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.code, "1030"));
      const [custBefore] = await db.select().from(customers).where(eq(customers.code, "CUST-SYN-01"));
      const [vendBefore] = await db.select().from(vendors).where(eq(vendors.code, "VEND-SYN-01"));

      // 1. Partial Products update: ONLY sku + selling_price (omit name, barcode, cost_price, category, brand)
      const prodPatch = await app.inject({
        method: "POST",
        url: "/api/imports/products",
        headers: adminHeaders,
        payload: {
          csv: "sku,selling_price\nSYN-VALVE-01,275\n",
          dryRun: false,
          updateExisting: true,
        },
      });
      expect(prodPatch.statusCode).toBe(200);
      expect(prodPatch.json().valid).toBe(true);
      expect(prodPatch.json().updatedCount).toBe(1);

      const [prodAfter] = await db.select().from(products).where(eq(products.sku, "SYN-VALVE-01"));
      const [bpAfter] = await db
        .select()
        .from(branchProducts)
        .where(eq(branchProducts.productId, prodAfter!.id));
      expect(Number(prodAfter!.sellingPrice)).toBe(275);
      expect(prodAfter!.name).toBe(bpBefore!.products.name); // omitted column preserved
      expect(prodAfter!.barcode).toBe(bpBefore!.products.barcode); // omitted column preserved
      expect(Number(prodAfter!.costPrice)).toBe(Number(bpBefore!.products.costPrice)); // omitted column preserved
      // Balances untouched!
      expect(Number(bpAfter!.qtyOnHand)).toBe(Number(bpBefore!.branch_products.qtyOnHand));
      expect(Number(bpAfter!.avgCost)).toBe(Number(bpBefore!.branch_products.avgCost));

      // 2. Partial Customers update: ONLY code + phone (omit name, tax_number, credit_limit)
      const custPatch = await app.inject({
        method: "POST",
        url: "/api/imports/customers",
        headers: adminHeaders,
        payload: {
          csv: "code,phone\nCUST-SYN-01,+201099999999\n",
          dryRun: false,
          updateExisting: true,
        },
      });
      expect(custPatch.statusCode).toBe(200);
      expect(custPatch.json().valid).toBe(true);
      const [custAfter] = await db.select().from(customers).where(eq(customers.code, "CUST-SYN-01"));
      expect(custAfter!.phone).toBe("+201099999999");
      expect(custAfter!.name).toBe(custBefore!.name);
      expect(custAfter!.taxNumber).toBe(custBefore!.taxNumber);
      expect(Number(custAfter!.creditLimit)).toBe(Number(custBefore!.creditLimit));

      // 3. Partial Vendors update: ONLY code + email (omit name, tax_number)
      const vendPatch = await app.inject({
        method: "POST",
        url: "/api/imports/vendors",
        headers: adminHeaders,
        payload: {
          csv: "code,email\nVEND-SYN-01,updated@vendor.eg\n",
          dryRun: false,
          updateExisting: true,
        },
      });
      expect(vendPatch.statusCode).toBe(200);
      expect(vendPatch.json().valid).toBe(true);
      const [vendAfter] = await db.select().from(vendors).where(eq(vendors.code, "VEND-SYN-01"));
      expect(vendAfter!.email).toBe("updated@vendor.eg");
      expect(vendAfter!.name).toBe(vendBefore!.name);
      expect(vendAfter!.taxNumber).toBe(vendBefore!.taxNumber);

      // 4. Partial COA update: ONLY code + description (omit name, account_type, normal_balance)
      const coaPatch = await app.inject({
        method: "POST",
        url: "/api/imports/chart_of_accounts",
        headers: adminHeaders,
        payload: {
          csv: "code,description\n1030,Updated CIB Operating Description\n",
          dryRun: false,
          updateExisting: true,
        },
      });
      expect(coaPatch.statusCode).toBe(200);
      expect(coaPatch.json().valid).toBe(true);
      const [coaAfter] = await db.select().from(chartOfAccounts).where(eq(chartOfAccounts.code, "1030"));
      expect(coaAfter!.description).toBe("Updated CIB Operating Description");
      expect(coaAfter!.name).toBe(coaBefore!.name);
      expect(coaAfter!.accountType).toBe(coaBefore!.accountType);
      expect(coaAfter!.normalBalance).toBe(coaBefore!.normalBalance);

      // Opening AR balance & all 8 reconciliation controls untouched!
      const [arAfter] = await db
        .select()
        .from(salesInvoices)
        .where(eq(salesInvoices.invoiceNumber, "OPEN-AR-2025-001"));
      expect(Number(arAfter!.totalAmount)).toBe(Number(arBefore!.totalAmount));
      expect(Number(arAfter!.paidAmount)).toBe(Number(arBefore!.paidAmount));

      const readiness = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: adminHeaders,
      });
      expect(readiness.statusCode).toBe(200);
      expect(readiness.json().ready).toBe(true);
    });
  });

  describe("3. Configurable CSV_IMPORT_MAX_ROWS & 10,000-row products benchmark", () => {
    it("3a. enforces CSV_IMPORT_MAX_ROWS env var dynamically", async () => {
      process.env.CSV_IMPORT_MAX_ROWS = "5";
      const rows = ["sku,name,cost_price,selling_price"];
      for (let i = 1; i <= 6; i++) {
        rows.push(`LIM-SKU-${i},Item ${i},10,20`);
      }
      const tooMany = await app.inject({
        method: "POST",
        url: "/api/imports/products",
        headers: adminHeaders,
        payload: { csv: rows.join("\n"), dryRun: true },
      });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().code).toBe("CSV_ROW_LIMIT_EXCEEDED");
      expect(tooMany.json().message).toContain("exceeding maximum limit of 5 rows");

      process.env.CSV_IMPORT_MAX_ROWS = "10";
      const withinLimit = await app.inject({
        method: "POST",
        url: "/api/imports/products",
        headers: adminHeaders,
        payload: { csv: rows.join("\n"), dryRun: true },
      });
      expect(withinLimit.statusCode).toBe(200);
      expect(withinLimit.json().valid).toBe(true);
      expect(withinLimit.json().createdCount).toBe(6);
    });

    it("3b. imports a 10,000-row products CSV within reasonable time and memory", async () => {
      const rowCount = 10_000;
      const lines = new Array<string>(rowCount + 1);
      lines[0] = "sku,name,name_ar,barcode,category,brand,unit,cost_price,selling_price,min_stock_level,item_type,eta_code_type,eta_item_code,eta_unit_type";
      for (let i = 1; i <= rowCount; i++) {
        const padded = String(i).padStart(5, "0");
        lines[i] = `BULK-${padded},Product ${padded},منتج ${padded},6220000${padded},Electronics,Delta,pcs,100.50,150.75,5,stock,EGS,EG-200300400-${padded},EA`;
      }
      const csv = lines.join("\n");
      const csvBytes = Buffer.byteLength(csv, "utf8");

      const memBeforeDry = process.memoryUsage();
      const dryStart = performance.now();
      const dryRes = await app.inject({
        method: "POST",
        url: "/api/imports/products",
        headers: adminHeaders,
        payload: { csv, dryRun: true },
      });
      const dryMs = Math.round(performance.now() - dryStart);
      expect(dryRes.statusCode).toBe(200);
      expect(dryRes.json().valid).toBe(true);
      expect(dryRes.json().createdCount).toBe(rowCount);

      const memBeforeCommit = process.memoryUsage();
      const commitStart = performance.now();
      const commitRes = await app.inject({
        method: "POST",
        url: "/api/imports/products",
        headers: adminHeaders,
        payload: { csv, dryRun: false },
      });
      const commitMs = Math.round(performance.now() - commitStart);
      const memAfterCommit = process.memoryUsage();

      expect(commitRes.statusCode).toBe(200);
      expect(commitRes.json().valid).toBe(true);
      expect(commitRes.json().createdCount).toBe(rowCount);

      const [{ cnt }] = await db.select({ cnt: sql<number>`count(*)::int` }).from(products);
      expect(cnt).toBe(rowCount);

      const heapDeltaMb = Number(((memAfterCommit.heapUsed - memBeforeDry.heapUsed) / (1024 * 1024)).toFixed(2));
      const peakRssMb = Number((Math.max(memBeforeDry.rss, memBeforeCommit.rss, memAfterCommit.rss) / (1024 * 1024)).toFixed(2));
      console.log(
        `[BENCHMARK 10k products] csvSizeKB=${Math.round(csvBytes / 1024)} dryRunMs=${dryMs} commitMs=${commitMs} heapDeltaMB=${heapDeltaMb} rssMB=${peakRssMb}`
      );

      // Reasonable performance guardrails (well under 30s on local Docker Postgres)
      expect(dryMs).toBeLessThan(15_000);
      expect(commitMs).toBeLessThan(30_000);
    }, 60_000);
  });

  describe("4. Read-only Cutover Readiness Admin Check (GET /api/imports/cutover-readiness)", () => {
    it("4a. passes when clean, is strictly read-only, denies non-admin, and fails on reconciliation / setup-health / audit-chain errors", async () => {
      await seedFullCutover();

      // Non-admin gets 403
      const userSignup = await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { name: "Regular User", email: "regular@test.local", password: "StrongPassword123!" },
      });
      const userHeaders = authHeaders(userSignup);
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: userHeaders,
      });
      expect(forbidden.statusCode).toBe(403);

      // Clean state -> PASS and read-only (audit row count unchanged)
      const [{ auditBefore }] = await db.select({ auditBefore: sql<number>`count(*)::int` }).from(auditLogs);
      const cleanRes = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: adminHeaders,
      });
      expect(cleanRes.statusCode).toBe(200);
      const cleanBody = cleanRes.json();
      expect(cleanBody.ready).toBe(true);
      expect(cleanBody.status).toBe("PASS");
      expect(cleanBody.checks.reconciliation.passed).toBe(true);
      expect(cleanBody.checks.reconciliation.totalControls).toBe(8);
      expect(cleanBody.checks.setupHealth.passed).toBe(true);
      expect(cleanBody.checks.auditChain.passed).toBe(true);

      const [{ auditAfter }] = await db.select({ auditAfter: sql<number>`count(*)::int` }).from(auditLogs);
      expect(auditAfter).toBe(auditBefore);

      // Break 1: Reconciliation out of balance (post manual JE directly to AR 1100 without subledger invoice)
      const coaRows = await db.select().from(chartOfAccounts);
      const arAcct = coaRows.find((a) => a.code === "1100")!;
      const revAcct = coaRows.find((a) => a.code === "4000")!;
      const jeRes = await app.inject({
        method: "POST",
        url: "/api/accounting/journal-entries",
        headers: adminHeaders,
        payload: {
          entryDate: "2026-01-15",
          memo: "Manual AR entry causing subledger mismatch",
          lines: [
            { accountId: arAcct.id, debit: 1234, credit: 0 },
            { accountId: revAcct.id, debit: 0, credit: 1234 },
          ],
        },
      });
      expect(jeRes.statusCode).toBe(201);

      const failRecon = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: adminHeaders,
      });
      expect(failRecon.statusCode).toBe(200);
      expect(failRecon.json().ready).toBe(false);
      expect(failRecon.json().status).toBe("FAIL");
      expect(failRecon.json().checks.reconciliation.passed).toBe(false);
      expect(failRecon.json().checks.reconciliation.failingKeys).toContain("accounts_receivable");

      // Break 2: Setup Health broken (deactivate mapped retained_earnings 3100)
      await db.update(chartOfAccounts).set({ isActive: false }).where(eq(chartOfAccounts.code, "3100"));
      const failSetup = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: adminHeaders,
      });
      expect(failSetup.statusCode).toBe(200);
      expect(failSetup.json().ready).toBe(false);
      expect(failSetup.json().checks.setupHealth.passed).toBe(false);
      expect(failSetup.json().checks.setupHealth.issueCount).toBeGreaterThan(0);

      // Break 3: Audit hash chain tampered
      const [firstAudit] = await db.select().from(auditLogs).limit(1);
      await db
        .update(auditLogs)
        .set({ entityLabel: "TAMPERED-BY-TEST" })
        .where(eq(auditLogs.id, firstAudit!.id));

      const failAudit = await app.inject({
        method: "GET",
        url: "/api/imports/cutover-readiness",
        headers: adminHeaders,
      });
      expect(failAudit.statusCode).toBe(200);
      expect(failAudit.json().ready).toBe(false);
      expect(failAudit.json().status).toBe("FAIL");
      expect(failAudit.json().checks.auditChain.passed).toBe(false);
      expect(failAudit.json().checks.auditChain.firstBrokenId).toBe(firstAudit!.id);
    });
  });
});
