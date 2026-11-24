import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { einvoiceSubmissions, notifications, salesInvoices } from "../../drizzle/schema.ts";

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

describe.skipIf(!testDbUrl)("POS Register, Hybrid PIN, Offline Sync, ETA Egypt & Pagination Integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let cashierCookie: string;
  let adminUserId: string;
  let cashierUserId: string;
  let hqBranchId: string;
  let secondBranchId: string;
  let terminalId: string;
  let stockProductId: string;
  let serviceProductId: string;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    app = await buildApp({ logger: false });
    await app.ready();

    const expectedDb = new URL(testDbUrl!).pathname.replace(/^\//, "");
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();
    const check = await db.execute(sql`SELECT current_database() AS db`);
    const activeDb = (check[0] as { db?: string } | undefined)?.db;
    if (activeDb !== expectedDb) {
      throw new Error(`Refusing to run destructive integration tests against '${activeDb}' instead of '${expectedDb}'`);
    }

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);

    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "POS Admin", email: "pos-admin@test.local", password: "Password123!" },
    });
    expect(adminSignup.statusCode).toBe(201);
    adminUserId = adminSignup.json().user.id;
    adminCookie = adminSignup.cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
    });
    hqBranchId = branchesRes.json().branches[0].id;

    // Create a second branch for isolation checks
    const br2 = await app.inject({
      method: "POST",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
      payload: { code: "RET-02", name: "Retail Branch 2", branchType: "retail" },
    });
    expect(br2.statusCode).toBe(201);
    secondBranchId = br2.json().branch.id;

    // Create a cashier user scoped ONLY to HQ branch
    const createCashier = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { erp_session: adminCookie },
      payload: {
        name: "Cashier Sara",
        email: "cashier@test.local",
        password: "Password123!",
        role: "user",
        branchScopeMode: "selected",
        branchIds: [hqBranchId],
        defaultBranchId: hqBranchId,
      },
    });
    expect(createCashier.statusCode).toBe(201);
    cashierUserId = createCashier.json().user.id;

    const cashierLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "cashier@test.local", password: "Password123!" },
    });
    expect(cashierLogin.statusCode).toBe(200);
    cashierCookie = cashierLogin.cookies.find((c) => c.name === "erp_session")!.value;

    // Create one stock product (qty 10) and one non_stock service product
    const p1 = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "POS-ITEM-1",
        barcode: "6221000000011",
        name: "Espresso Pack",
        costPrice: 40,
        sellingPrice: 114,
        itemType: "stock",
      },
    });
    expect(p1.statusCode).toBe(201);
    stockProductId = p1.json().product.id;

    const p2 = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "POS-SVC-1",
        name: "Gift Wrapping",
        costPrice: 0,
        sellingPrice: 20,
        itemType: "service",
      },
    });
    expect(p2.statusCode).toBe(201);
    serviceProductId = p2.json().product.id;

    // Seed 10 units of stockProductId in HQ via stock adjustment
    const adj = await app.inject({
      method: "POST",
      url: "/api/adjustments",
      cookies: { erp_session: adminCookie },
      payload: {
        branchId: hqBranchId,
        reason: "initial_count",
        notes: "POS seed stock",
        lines: [{ productId: stockProductId, qtyDelta: 10, unitCost: 40 }],
      },
    });
    expect(adj.statusCode).toBe(201);

    // Create POS terminal on HQ branch
    const termRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminals",
      cookies: { erp_session: adminCookie },
      payload: {
        branchId: hqBranchId,
        code: "REG-01",
        name: "Front Counter Register 1",
        paperWidthMm: 80,
        etaPosSerial: "EG-POS-001",
      },
    });
    expect(termRes.statusCode).toBe(201);
    terminalId = termRes.json().terminal.id;
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("executes POS shift open, split-tender checkout with inclusive VAT & ETA Egypt receipt, and shift close variance GL", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();

    // Enable ETA Egypt e-Receipt mode in company settings
    const settingsUpdate = await app.inject({
      method: "PUT",
      url: "/api/settings/company",
      cookies: { erp_session: adminCookie },
      payload: {
        companyName: "Cairo Coffee Co",
        legalName: "Cairo Coffee Co LLC",
        taxRegistrationNumber: "555666777",
        baseCurrency: "EGP",
        einvoicingMode: "eta_egypt",
      },
    });
    expect(settingsUpdate.statusCode).toBe(200);

    // Open shift with 500 float
    const shiftOpen = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, openingFloat: 500, notes: "Morning shift" },
    });
    expect(shiftOpen.statusCode).toBe(201);
    const shiftId = shiftOpen.json().shift.id as string;

    // Attempting second open shift on same terminal must return 409
    const dupShift = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, openingFloat: 100 },
    });
    expect(dupShift.statusCode).toBe(409);

    // Checkout: 1x stock item (114 inclusive @ 14% VAT => 100 net + 14 VAT) + 1x service item (20 @ 0% VAT) = 134 total
    // Split tender: 100 cash (tendered 120 -> 20 change) + 34 card
    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      cookies: { erp_session: adminCookie },
      payload: {
        terminalId,
        shiftId,
        lines: [
          {
            productId: stockProductId,
            description: "Espresso Pack",
            quantity: 1,
            unitPrice: 114,
            discount: 0,
            taxRate: 14,
            isTaxInclusive: true,
          },
          {
            productId: serviceProductId,
            description: "Gift Wrapping",
            quantity: 1,
            unitPrice: 20,
            discount: 0,
            taxRate: 0,
            isTaxInclusive: false,
          },
        ],
        tenders: [
          { method: "cash", amount: 100, tenderedAmount: 120 },
          { method: "card", amount: 34, tenderedAmount: 34, reference: "VISA-4242" },
        ],
      },
    });
    expect(checkout.statusCode).toBe(201);
    const receipt = checkout.json().receipt;
    expect(receipt.subtotal).toBeCloseTo(120, 2);
    expect(receipt.taxTotal).toBeCloseTo(14, 2);
    expect(receipt.totalAmount).toBeCloseTo(134, 2);
    expect(receipt.totalChangeGiven).toBeCloseTo(20, 2);
    expect(receipt.etaDocumentUuid).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.qrTlv).toContain("https://invoicing.eta.gov.eg/receipts/search/");

    // Verify einvoice_submissions queue row created
    const subRows = await db
      .select()
      .from(einvoiceSubmissions)
      .where(eq(einvoiceSubmissions.invoiceId, receipt.id));
    expect(subRows).toHaveLength(1);
    expect(subRows[0].provider).toBe("eta_egypt");
    expect(subRows[0].status).toBe("pending");

    // Record cash safe drop of 50 -> expected cash = 500 + 100 - 50 = 550
    const drop = await app.inject({
      method: "POST",
      url: `/api/pos/shifts/${shiftId}/cash-movement`,
      cookies: { erp_session: adminCookie },
      payload: { movementType: "safe_drop", amount: 50, reason: "Mid-day drop" },
    });
    expect(drop.statusCode).toBe(201);
    expect(drop.json().movement.expectedCash).toBeCloseTo(550, 2);

    // Close shift with countedCash 540 (shortage of -10 -> posts cash_over_short GL)
    const closed = await app.inject({
      method: "POST",
      url: `/api/pos/shifts/${shiftId}/close`,
      cookies: { erp_session: adminCookie },
      payload: { countedCash: 540, notes: "Short by 10" },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().shift.expectedCash).toBeCloseTo(550, 2);
    expect(closed.json().shift.cashVariance).toBeCloseTo(-10, 2);

    // Trial balance & Balance Sheet must remain strictly balanced via SQL GROUP BY reports
    const tb = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      cookies: { erp_session: adminCookie },
    });
    expect(tb.statusCode).toBe(200);
    expect(tb.json().isBalanced).toBe(true);

    const bs = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/balance-sheet",
      cookies: { erp_session: adminCookie },
    });
    expect(bs.statusCode).toBe(200);
    expect(bs.json().isBalanced).toBe(true);
  });

  it("enforces hybrid terminal lock (423), cashier PIN switch, and 5-strike 429 lockout", async () => {
    // Admin sets PINs for both admin and cashier
    const pinAdmin = await app.inject({
      method: "PUT",
      url: `/api/users/${adminUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "1234" },
    });
    expect(pinAdmin.statusCode).toBe(200);

    const pinCashier = await app.inject({
      method: "PUT",
      url: `/api/users/${cashierUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "5678" },
    });
    expect(pinCashier.statusCode).toBe(200);

    // Bind admin session to terminal
    const bindRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminal/bind",
      cookies: { erp_session: adminCookie },
      payload: { terminalId },
    });
    expect(bindRes.statusCode).toBe(200);

    // Lock terminal
    const lockRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminal/lock",
      cookies: { erp_session: adminCookie },
    });
    expect(lockRes.statusCode).toBe(200);

    // Protected ERP endpoints must return 423 TERMINAL_LOCKED while locked
    const blockedProducts = await app.inject({
      method: "GET",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
    });
    expect(blockedProducts.statusCode).toBe(423);
    expect(blockedProducts.json().code).toBe("TERMINAL_LOCKED");

    // 5 wrong PIN attempts for cashier -> 429 PIN_LOCKED
    for (let i = 0; i < 4; i++) {
      const bad = await app.inject({
        method: "POST",
        url: "/api/pos/terminal/pin-switch",
        cookies: { erp_session: adminCookie },
        payload: { terminalId, userId: cashierUserId, pin: "0000" },
      });
      expect(bad.statusCode).toBe(401);
    }
    const fifthBad = await app.inject({
      method: "POST",
      url: "/api/pos/terminal/pin-switch",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, userId: cashierUserId, pin: "0000" },
    });
    expect(fifthBad.statusCode).toBe(429);
    expect(fifthBad.json().code).toBe("PIN_LOCKED");

    // Admin unlocks with their PIN ("1234")
    const unlockAdmin = await app.inject({
      method: "POST",
      url: "/api/pos/terminal/pin-switch",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, userId: adminUserId, pin: "1234" },
    });
    expect(unlockAdmin.statusCode).toBe(200);
    expect(unlockAdmin.json().user.id).toBe(adminUserId);
    expect(unlockAdmin.json().isLocked).toBe(false);

    // Reset cashier PIN lockout and switch session active cashier to Sara
    await app.inject({
      method: "PUT",
      url: `/api/users/${cashierUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "5678" },
    });
    const switchToCashier = await app.inject({
      method: "POST",
      url: "/api/pos/terminal/pin-switch",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, userId: cashierUserId, pin: "5678" },
    });
    expect(switchToCashier.statusCode).toBe(200);
    expect(switchToCashier.json().user.id).toBe(cashierUserId);

    // Verify /api/auth/me now reports active cashier Sara
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { erp_session: adminCookie },
    });
    expect(me.json().user.id).toBe(cashierUserId);

    // Switch back to Admin for subsequent tests
    await app.inject({
      method: "POST",
      url: "/api/pos/terminal/pin-switch",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, userId: adminUserId, pin: "1234" },
    });
  });

  it("handles offline sync idempotency replay and negative-stock conflict reconciliation", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();

    // Open a fresh shift on terminal
    const shiftOpen = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      cookies: { erp_session: adminCookie },
      payload: { terminalId, openingFloat: 200 },
    });
    expect(shiftOpen.statusCode).toBe(201);
    const shiftId = shiftOpen.json().shift.id as string;

    const clientTxId = "11111111-2222-4333-8444-555555555555";
    // Stock currently has 9 units; offline sale sells 15 units -> triggers negative stock conflict reconciliation!
    const batchPayload = {
      terminalId,
      sales: [
        {
          terminalId,
          shiftId,
          offlineClientTxId: clientTxId,
          offlineCreatedAt: new Date().toISOString(),
          lines: [
            {
              productId: stockProductId,
              description: "Espresso Pack",
              quantity: 15,
              unitPrice: 100,
              discount: 0,
              taxRate: 0,
              isTaxInclusive: false,
            },
          ],
          tenders: [{ method: "cash", amount: 1500, tenderedAmount: 1500 }],
        },
      ],
    };

    const sync1 = await app.inject({
      method: "POST",
      url: "/api/pos/sync",
      cookies: { erp_session: adminCookie },
      payload: batchPayload,
    });
    expect(sync1.statusCode).toBe(200);
    expect(sync1.json().results[0].status).toBe("reconciled_conflict");
    const syncedInvoiceId = sync1.json().results[0].receipt.id as string;

    // Verify notification raised
    const conflictNotifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.entityId, syncedInvoiceId));
    expect(conflictNotifs.length).toBeGreaterThanOrEqual(1);

    // Replaying exact same offline batch must deduplicate without creating a second invoice!
    const sync2 = await app.inject({
      method: "POST",
      url: "/api/pos/sync",
      cookies: { erp_session: adminCookie },
      payload: batchPayload,
    });
    expect(sync2.statusCode).toBe(200);
    expect(sync2.json().results[0].status).toBe("deduplicated");

    const matchingInvs = await db
      .select({ id: salesInvoices.id })
      .from(salesInvoices)
      .where(eq(salesInvoices.offlineClientTxId, clientTxId));
    expect(matchingInvs).toHaveLength(1);
  });

  it("enforces cursor/offset pagination contracts and branch-scope isolation on payments & retainers", async () => {
    // Cursor pagination on /api/movements + malformed cursor -> 400 INVALID_CURSOR
    const movPage1 = await app.inject({
      method: "GET",
      url: "/api/movements?limit=1",
      cookies: { erp_session: adminCookie },
    });
    expect(movPage1.statusCode).toBe(200);
    expect(movPage1.json().items).toHaveLength(1);
    expect(movPage1.json().pageInfo.hasMore).toBe(true);

    const movPage2 = await app.inject({
      method: "GET",
      url: `/api/movements?limit=1&cursor=${encodeURIComponent(movPage1.json().pageInfo.nextCursor)}`,
      cookies: { erp_session: adminCookie },
    });
    expect(movPage2.statusCode).toBe(200);
    expect(movPage2.json().items).toHaveLength(1);
    expect(movPage2.json().items[0].id).not.toBe(movPage1.json().items[0].id);

    const badCursor = await app.inject({
      method: "GET",
      url: "/api/movements?cursor=not-a-valid-cursor",
      cookies: { erp_session: adminCookie },
    });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json().code).toBe("INVALID_CURSOR");

    // Offset pagination on /api/sales-invoices & /api/accounting/journal-entries
    const invPage = await app.inject({
      method: "GET",
      url: "/api/sales-invoices?page=1&pageSize=1",
      cookies: { erp_session: adminCookie },
    });
    expect(invPage.statusCode).toBe(200);
    expect(invPage.json().pageInfo.page).toBe(1);
    expect(invPage.json().pageInfo.total).toBeGreaterThanOrEqual(2);

    const jePage = await app.inject({
      method: "GET",
      url: "/api/accounting/journal-entries?page=1&pageSize=2",
      cookies: { erp_session: adminCookie },
    });
    expect(jePage.statusCode).toBe(200);
    expect(jePage.json().items.length).toBeLessThanOrEqual(2);
    expect(jePage.json().pageInfo.total).toBeGreaterThanOrEqual(2);

    // Branch isolation on received-payments: payment created in secondBranchId must NOT be visible to HQ-only cashier
    const custs = await app.inject({
      method: "GET",
      url: "/api/customers",
      cookies: { erp_session: adminCookie },
    });
    const custId = custs.json().customers[0].id as string;

    const payBr2 = await app.inject({
      method: "POST",
      url: "/api/received-payments",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId: custId,
        branchId: secondBranchId,
        amount: 75,
        paymentMethod: "Cash",
        allocations: [],
      },
    });
    expect(payBr2.statusCode).toBe(201);
    const br2PayId = payBr2.json().payment.id as string;

    const cashierPays = await app.inject({
      method: "GET",
      url: "/api/received-payments",
      cookies: { erp_session: cashierCookie },
    });
    expect(cashierPays.statusCode).toBe(200);
    const seenIds = (cashierPays.json().payments as Array<{ id: string }>).map((p) => p.id);
    expect(seenIds).not.toContain(br2PayId);
  });
});
