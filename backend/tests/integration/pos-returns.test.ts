import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { einvoiceSubmissions, posReturns, stockMovements } from "../../drizzle/schema.ts";

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

describe.skipIf(!testDbUrl)("POS Manager PIN Override, Receipt Search, Atomic POS Returns & ETA 'R' Receipts Integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let cashierCookie: string;
  let adminUserId: string;
  let cashierUserId: string;
  let hqBranchId: string;
  let terminalId: string;
  let productId: string;

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
      throw new Error(`Refusing to run integration tests against '${activeDb}' instead of '${expectedDb}'`);
    }

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);

    const adminSignup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "POS Supervisor", email: "pos-mgr@test.local", password: "Password123!" },
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

    // Enable ETA Egypt mode
    const compRes = await app.inject({
      method: "PUT",
      url: "/api/settings/company",
      cookies: { erp_session: adminCookie },
      payload: {
        companyName: "Cairo Roasters",
        legalName: "Cairo Roasters LLC",
        taxRegistrationNumber: "777888999",
        baseCurrency: "EGP",
        einvoicingMode: "eta_egypt",
      },
    });
    expect(compRes.statusCode).toBe(200);

    // Create standard cashier
    const createCashier = await app.inject({
      method: "POST",
      url: "/api/users",
      cookies: { erp_session: adminCookie },
      payload: {
        name: "Cashier Nour",
        email: "nour-cashier@test.local",
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
      payload: { email: "nour-cashier@test.local", password: "Password123!" },
    });
    expect(cashierLogin.statusCode).toBe(200);
    cashierCookie = cashierLogin.cookies.find((c) => c.name === "erp_session")!.value;

    // Set PINs for supervisor ("2468") and cashier ("1111")
    await app.inject({
      method: "PUT",
      url: `/api/users/${adminUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "2468" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/users/${cashierUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "1111" },
    });

    // Seed product with 20 units @ cost 40, selling 100
    const prodRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "POS-RET-01",
        barcode: "6229998887776",
        name: "Colombian Roast 1kg",
        costPrice: 40,
        sellingPrice: 100,
        initialStock: [{ branchId: hqBranchId, quantity: 20, unitCost: 40 }],
      },
    });
    expect(prodRes.statusCode).toBe(201);
    productId = prodRes.json().product.id;

    // Create POS terminal
    const termRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminals",
      cookies: { erp_session: adminCookie },
      payload: {
        branchId: hqBranchId,
        code: "REG-M4",
        name: "Counter Register M4",
        etaPosSerial: "EG-POS-M4",
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

  it("verifies manager PIN override boundaries without switching the active cashier session", async () => {
    // 1. Non-digit PIN -> 400
    const badFormat = await app.inject({
      method: "POST",
      url: "/api/pos/override/verify",
      cookies: { erp_session: cashierCookie },
      payload: { pin: "12ab", terminalId, action: "discount" },
    });
    expect(badFormat.statusCode).toBe(400);

    // 2. Cashier entering their own PIN -> 403 POS_OVERRIDE_FORBIDDEN
    const selfOverride = await app.inject({
      method: "POST",
      url: "/api/pos/override/verify",
      cookies: { erp_session: cashierCookie },
      payload: { pin: "1111", terminalId, action: "discount" },
    });
    expect(selfOverride.statusCode).toBe(403);
    expect(selfOverride.json().code).toBe("POS_OVERRIDE_FORBIDDEN");

    // 3. 5 wrong attempts against manager PIN -> 429 PIN_LOCKED
    for (let i = 0; i < 4; i++) {
      const wrong = await app.inject({
        method: "POST",
        url: "/api/pos/override/verify",
        cookies: { erp_session: cashierCookie },
        payload: { pin: "9999", managerUserId: adminUserId, terminalId, action: "discount" },
      });
      expect(wrong.statusCode).toBe(401);
    }
    const fifthWrong = await app.inject({
      method: "POST",
      url: "/api/pos/override/verify",
      cookies: { erp_session: cashierCookie },
      payload: { pin: "9999", managerUserId: adminUserId, terminalId, action: "discount" },
    });
    expect(fifthWrong.statusCode).toBe(429);
    expect(fifthWrong.json().code).toBe("PIN_LOCKED");

    // Reset supervisor PIN lockout
    await app.inject({
      method: "PUT",
      url: `/api/users/${adminUserId}/pos-pin`,
      cookies: { erp_session: adminCookie },
      payload: { pin: "2468" },
    });

    // 4. Valid manager PIN -> 200 verified
    const valid = await app.inject({
      method: "POST",
      url: "/api/pos/manager-override",
      cookies: { erp_session: cashierCookie },
      payload: {
        pin: "2468",
        terminalId,
        action: "discount",
        reason: "15% loyalty discount",
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().verified).toBe(true);
    expect(valid.json().approver.id).toBe(adminUserId);

    // 5. Session user MUST remain on cashier (Nour), never switched to supervisor!
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { erp_session: cashierCookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.id).toBe(cashierUserId);
  });

  it("searches POS receipts, executes partial restocked cash return + non-restocked card return, queues ETA 'R' receipts, and reconciles shift + GL", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();

    // Open shift with 200 opening float as cashier
    const shiftOpen = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      cookies: { erp_session: cashierCookie },
      payload: { terminalId, openingFloat: 200 },
    });
    expect(shiftOpen.statusCode).toBe(201);
    const shiftId = shiftOpen.json().shift.id as string;

    // Checkout 2 units @ 100 with 10 discount (total 180) + 14% VAT (25.20) = 205.20
    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      cookies: { erp_session: cashierCookie },
      payload: {
        terminalId,
        shiftId,
        currency: "EGP",
        lines: [
          {
            productId,
            description: "Colombian Roast 1kg",
            quantity: 2,
            unitPrice: 100,
            discount: 20,
            taxRate: 14,
            isTaxInclusive: false,
          },
        ],
        tenders: [{ method: "cash", amount: 205.2, tenderedAmount: 205.2 }],
      },
    });
    expect(checkout.statusCode).toBe(201);
    const saleReceipt = checkout.json().receipt;
    expect(saleReceipt.totalAmount).toBeCloseTo(205.2, 2);

    // List receipts via GET /api/pos/receipts?q=POS-
    const listRes = await app.inject({
      method: "GET",
      url: `/api/pos/receipts?terminalId=${terminalId}&q=${encodeURIComponent(saleReceipt.invoiceNumber)}`,
      cookies: { erp_session: cashierCookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().receipts).toHaveLength(1);
    expect(listRes.json().receipts[0].id).toBe(saleReceipt.id);

    // Inspect receipt detail
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/pos/receipts/${saleReceipt.id}`,
      cookies: { erp_session: cashierCookie },
    });
    expect(detailRes.statusCode).toBe(200);
    const origLine = detailRes.json().receipt.lines[0];
    expect(origLine.quantity).toBe(2);
    expect(origLine.remainingReturnableQuantity).toBe(2);

    // Cashier return without managerOverridePin -> 403
    const noPinReturn = await app.inject({
      method: "POST",
      url: "/api/pos/returns",
      cookies: { erp_session: cashierCookie },
      payload: {
        originalInvoiceId: saleReceipt.id,
        terminalId,
        shiftId,
        refundMethod: "cash",
        restockItems: true,
        reason: "Missing PIN",
        lines: [{ originalInvoiceLineId: origLine.id, productId, quantity: 1 }],
      },
    });
    expect(noPinReturn.statusCode).toBe(403);

    // Partial return 1 of 2 (cash refund, restockItems: true) with managerOverridePin -> 201
    const cashReturn = await app.inject({
      method: "POST",
      url: "/api/pos/returns",
      cookies: { erp_session: cashierCookie },
      payload: {
        originalInvoiceId: saleReceipt.id,
        terminalId,
        shiftId,
        refundMethod: "cash",
        restockItems: true,
        reason: "Damaged bag",
        managerOverridePin: "2468",
        lines: [{ originalInvoiceLineId: origLine.id, productId, quantity: 1 }],
      },
    });
    expect(cashReturn.statusCode).toBe(201);
    const ret1 = cashReturn.json().posReturn;
    expect(ret1.returnNumber).toMatch(/^POSR-/);
    expect(ret1.totalAmount).toBeCloseTo(102.6, 2);
    expect(ret1.etaDocumentUuid).toMatch(/^[a-f0-9]{64}$/);

    // Verify stock restored from 18 to 19 and stock_movements row recorded
    const catAfterRet1 = await app.inject({
      method: "GET",
      url: `/api/pos/catalog?branchId=${hqBranchId}`,
      cookies: { erp_session: cashierCookie },
    });
    const prodAfterRet1 = (catAfterRet1.json().products as Array<{ id: string; qtyOnHand: number }>).find(
      (p) => p.id === productId
    );
    expect(prodAfterRet1?.qtyOnHand).toBe(19);

    const movRows = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.referenceId, ret1.id));
    expect(movRows).toHaveLength(1);
    expect(movRows[0].movementType).toBe("sales_return");
    expect(movRows[0].referenceType).toBe("pos_return");

    // Verify ETA 'R' submission row queued referencing original invoice's etaDocumentUuid
    const etaSubRows = await db
      .select()
      .from(einvoiceSubmissions)
      .where(eq(einvoiceSubmissions.posReturnId, ret1.id));
    expect(etaSubRows).toHaveLength(1);
    expect(etaSubRows[0].invoiceId).toBeNull();
    expect(etaSubRows[0].status).toBe("pending");
    const [ret1Db] = await db.select().from(posReturns).where(eq(posReturns.id, ret1.id));
    const retPayload = ret1Db.eInvoicePayloadJson as {
      header?: { referenceUUID?: string; receiptType?: string };
      documentType?: { receiptType?: string };
    };
    expect(retPayload.documentType?.receiptType).toBe("R");
    expect(retPayload.header?.referenceUUID).toBe(saleReceipt.etaDocumentUuid);

    // Over-return (requesting 2 when only 1 remains) -> 400
    const overReturn = await app.inject({
      method: "POST",
      url: "/api/pos/returns",
      cookies: { erp_session: cashierCookie },
      payload: {
        originalInvoiceId: saleReceipt.id,
        terminalId,
        shiftId,
        refundMethod: "cash",
        restockItems: true,
        reason: "Over return",
        managerOverridePin: "2468",
        lines: [{ originalInvoiceLineId: origLine.id, productId, quantity: 2 }],
      },
    });
    expect(overReturn.statusCode).toBe(400);

    // Remainder return 1 of 2 with restockItems: false & refundMethod: "card" -> stock stays 19
    const cardReturn = await app.inject({
      method: "POST",
      url: "/api/pos/returns",
      cookies: { erp_session: cashierCookie },
      payload: {
        originalInvoiceId: saleReceipt.id,
        terminalId,
        shiftId,
        refundMethod: "card",
        restockItems: false,
        reason: "Opened bag - do not restock",
        managerOverridePin: "2468",
        lines: [{ originalInvoiceLineId: origLine.id, productId, quantity: 1 }],
      },
    });
    expect(cardReturn.statusCode).toBe(201);

    const catAfterRet2 = await app.inject({
      method: "GET",
      url: `/api/pos/catalog?branchId=${hqBranchId}`,
      cookies: { erp_session: cashierCookie },
    });
    const prodAfterRet2 = (catAfterRet2.json().products as Array<{ id: string; qtyOnHand: number }>).find(
      (p) => p.id === productId
    );
    expect(prodAfterRet2?.qtyOnHand).toBe(19);

    // Verify shift accumulators and expectedCash = 200 + 205.20 - 102.60 = 302.60
    const activeShiftRes = await app.inject({
      method: "GET",
      url: `/api/pos/shifts/active?terminalId=${terminalId}`,
      cookies: { erp_session: cashierCookie },
    });
    expect(activeShiftRes.statusCode).toBe(200);
    const activeShift = activeShiftRes.json().shift;
    expect(activeShift.totalRefundsCount).toBe(2);
    expect(activeShift.totalCashRefunds).toBeCloseTo(102.6, 2);
    expect(activeShift.totalCardRefunds).toBeCloseTo(102.6, 2);
    expect(activeShift.expectedCash).toBeCloseTo(302.6, 2);

    // Close shift with exact expectedCash -> cashVariance === 0
    const closeRes = await app.inject({
      method: "POST",
      url: `/api/pos/shifts/${shiftId}/close`,
      cookies: { erp_session: cashierCookie },
      payload: { countedCash: activeShift.expectedCash },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json().shift.cashVariance).toBe(0);

    // Trial balance must be balanced
    const tbRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      cookies: { erp_session: adminCookie },
    });
    expect(tbRes.statusCode).toBe(200);
    expect(tbRes.json().isBalanced).toBe(true);
  });
});
