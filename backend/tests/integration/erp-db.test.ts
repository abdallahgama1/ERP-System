import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDbUrl) {
  process.env.DATABASE_URL = testDbUrl;
}

describe.skipIf(!testDbUrl)("PostgreSQL ERP transaction & concurrency invariants", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    app = await buildApp({ logger: false });
    await app.ready();

    const expectedDb = new URL(testDbUrl!).pathname.replace(/^\//, "");
    const { getDb } = await import("../../src/db/index.ts");
    const check = await getDb().execute(sql`SELECT current_database() AS db`);
    const activeDb = (check[0] as { db?: string } | undefined)?.db;
    if (activeDb !== expectedDb) {
      throw new Error(`Refusing to run destructive integration tests against '${activeDb}' instead of '${expectedDb}'`);
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  it("bootstraps first signup as admin safely under concurrent signups and isolates branches", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();

    // Reset transactional & GL tables cleanly in isolated TEST_DATABASE_URL
    await db.execute(
      sql`TRUNCATE TABLE journal_lines, journal_entries, fiscal_periods, fiscal_years, exchange_rates, audit_logs, credit_note_applications, retainer_applications, retainer_invoices, sales_return_lines, sales_returns, received_payment_allocations, received_payments, sales_invoice_lines, sales_invoices, sales_order_lines, sales_orders, purchase_return_lines, purchase_returns, payment_made_allocations, payments_made, vendor_bill_lines, vendor_bills, purchase_receive_lines, purchase_receives, purchase_order_lines, purchase_orders, stock_transfer_lines, stock_transfers, stock_session_items, stock_sessions, stock_write_off_lines, stock_write_offs, stock_adjustment_lines, stock_adjustments, stock_movements, branch_products, products, taxonomy_items, customers, vendors, user_branches, user_branch_scopes, user_roles, user_sessions, users, branches RESTART IDENTITY CASCADE`
    );

    const [signupA, signupB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { name: "Admin User", email: "admin@test.local", password: "Password123!" },
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { name: "Second User", email: "user@test.local", password: "Password123!" },
      }),
    ]);

    expect(signupA.statusCode).toBe(201);
    expect(signupB.statusCode).toBe(201);

    const usersRes = [signupA.json().user, signupB.json().user];
    const admins = usersRes.filter((u) => u.role === "admin");
    const regulars = usersRes.filter((u) => u.role === "user");
    expect(admins).toHaveLength(1);
    expect(regulars).toHaveLength(1);
    expect(admins[0].branchScopeMode).toBe("all");
    expect(regulars[0].branchScopeMode).toBe("selected");

    const adminSignup = admins[0].id === signupA.json().user.id ? signupA : signupB;
    const regularSignup = admins[0].id === signupA.json().user.id ? signupB : signupA;
    const adminCookie = adminSignup.cookies.find((c) => c.name === "erp_session")!.value;
    const regularCookie = regularSignup.cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
    });
    const hqId = branchesRes.json().branches[0].id as string;

    // Regular user without branch assignment must be rejected with 403 BRANCH_FORBIDDEN
    const forbiddenCustRes = await app.inject({
      method: "POST",
      url: "/api/sales-orders",
      cookies: { erp_session: regularCookie },
      payload: {
        customerId: "11111111-1111-4111-8111-111111111111",
        branchId: hqId,
        lines: [{ productId: "22222222-2222-4222-8222-222222222222", quantity: 1, unitPrice: 10 }],
      },
    });
    expect(forbiddenCustRes.statusCode).toBe(403);
  });

  it("enforces WMAC costing on PO receive and FOR UPDATE oversell rejection on sales invoice", async () => {
    const { getDb } = await import("../../src/db/index.ts");
    const db = getDb();

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const cookie =
      adminLogin.statusCode === 200
        ? adminLogin.cookies.find((c) => c.name === "erp_session")!.value
        : (
            await app.inject({
              method: "POST",
              url: "/api/auth/login",
              payload: { email: "user@test.local", password: "Password123!" },
            })
          ).cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({ method: "GET", url: "/api/branches", cookies: { erp_session: cookie } });
    const hqId = branchesRes.json().branches[0].id as string;

    const prodRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: cookie },
      payload: {
        sku: "SKU-INT-1",
        name: "Integration Item",
        costPrice: 50,
        sellingPrice: 100,
        initialStock: [{ branchId: hqId, quantity: 10, unitCost: 50 }],
      },
    });
    expect(prodRes.statusCode).toBe(201);
    const productId = prodRes.json().product.id as string;

    const vendorRes = await app.inject({
      method: "POST",
      url: "/api/vendors",
      cookies: { erp_session: cookie },
      payload: { name: "Acme Supplier" },
    });
    const vendorId = vendorRes.json().vendor.id as string;

    // Receive 10 more units at cost 70 -> new WMAC = (10*50 + 10*70)/20 = 60
    const rcvRes = await app.inject({
      method: "POST",
      url: "/api/purchase-receives",
      cookies: { erp_session: cookie },
      payload: {
        vendorId,
        branchId: hqId,
        lines: [{ productId, quantity: 10, unitCost: 70 }],
      },
    });
    expect(rcvRes.statusCode).toBe(201);

    const bpRows = await db.execute<{ qty_on_hand: string; avg_cost: string }>(
      sql`SELECT qty_on_hand, avg_cost FROM branch_products WHERE branch_id = ${hqId} AND product_id = ${productId}`
    );
    expect(Number(bpRows[0].qty_on_hand)).toBe(20);
    expect(Number(bpRows[0].avg_cost)).toBe(60);

    const customerRes = await app.inject({
      method: "POST",
      url: "/api/customers",
      cookies: { erp_session: cookie },
      payload: { name: "Retail Buyer" },
    });
    const customerId = customerRes.json().customer.id as string;

    // Attempt to invoice 25 units when only 20 exist -> must reject with 400 INSUFFICIENT_STOCK
    const oversell = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: cookie },
      payload: {
        customerId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId, quantity: 25, unitPrice: 100 }],
      },
    });
    expect(oversell.statusCode).toBe(400);
    expect(oversell.json().code).toBe("INSUFFICIENT_STOCK");

    // Invoice 5 units cleanly, pay them in full, then void the payment -> balance & status revert
    const invRes = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: cookie },
      payload: {
        customerId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId, quantity: 5, unitPrice: 100 }],
      },
    });
    expect(invRes.statusCode).toBe(201);
    const invoiceId = invRes.json().invoice.id as string;

    const payRes = await app.inject({
      method: "POST",
      url: "/api/received-payments",
      cookies: { erp_session: cookie },
      payload: {
        customerId,
        branchId: hqId,
        amount: 500,
        allocations: [{ invoiceId, amount: 500 }],
      },
    });
    expect(payRes.statusCode).toBe(201);
    const paymentId = payRes.json().payment.id as string;

    const voidPayRes = await app.inject({
      method: "POST",
      url: `/api/received-payments/${paymentId}/void`,
      cookies: { erp_session: cookie },
      payload: { reason: "Bounced cheque" },
    });
    expect(voidPayRes.statusCode).toBe(200);
    expect(voidPayRes.json().payment.status).toBe("Voided");

    const invAfterVoid = await app.inject({
      method: "GET",
      url: "/api/sales-invoices",
      cookies: { erp_session: cookie },
    });
    const checkedInv = invAfterVoid.json().invoices.find((i: { id: string }) => i.id === invoiceId);
    expect(checkedInv.status).toBe("Sent");
    expect(checkedInv.paidAmount).toBe(0);
  });

  it("transfers stock cleanly with shortage resolution and reconciles stock-take session variances", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const cookie = loginRes.cookies.find((c) => c.name === "erp_session")!.value;

    const brList = await app.inject({ method: "GET", url: "/api/branches", cookies: { erp_session: cookie } });
    const hqId = brList.json().branches[0].id as string;

    const branch2Res = await app.inject({
      method: "POST",
      url: "/api/branches",
      cookies: { erp_session: cookie },
      payload: { name: "Secondary Store", branchType: "retail" },
    });
    expect(branch2Res.statusCode).toBe(201);
    const storeId = branch2Res.json().branch.id as string;

    const prodList = await app.inject({ method: "GET", url: "/api/products", cookies: { erp_session: cookie } });
    const productId = prodList.json().products[0].id as string;

    // Transfer 5 units HQ -> Secondary Store, receive 4 with return_to_source shortage disposition
    const trRes = await app.inject({
      method: "POST",
      url: "/api/transfers",
      cookies: { erp_session: cookie },
      payload: {
        fromBranchId: hqId,
        toBranchId: storeId,
        status: "In Transit",
        lines: [{ productId, quantity: 5 }],
      },
    });
    expect(trRes.statusCode).toBe(201);
    const transferId = trRes.json().transfer.id as string;

    const rcvTrRes = await app.inject({
      method: "POST",
      url: `/api/transfers/${transferId}/receive`,
      cookies: { erp_session: cookie },
      payload: {
        items: [{ productId, qtyReceived: 4 }],
        shortageResolution: "return_to_source",
      },
    });
    expect(rcvTrRes.statusCode).toBe(200);
    expect(rcvTrRes.json().transfer.status).toBe("Received");

    // Start stock-take session at Secondary Store, record 6 instead of 4 (+2 variance) and complete
    const sessRes = await app.inject({
      method: "POST",
      url: "/api/sessions",
      cookies: { erp_session: cookie },
      payload: { branchId: storeId, name: "Monthly Retail Audit", productIds: [productId] },
    });
    expect(sessRes.statusCode).toBe(201);
    const sessionId = sessRes.json().session.id as string;

    const upsertRes = await app.inject({
      method: "PUT",
      url: `/api/sessions/${sessionId}/items`,
      cookies: { erp_session: cookie },
      payload: { items: [{ productId, countedQty: 6 }] },
    });
    expect(upsertRes.statusCode).toBe(200);

    const completeRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/complete`,
      cookies: { erp_session: cookie },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().session.status).toBe("Completed");
    expect(completeRes.json().session.adjustmentId).toBeTruthy();
  });

  it("maintains balanced Trial Balance & Balance Sheet and enforces fiscal period locks", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const cookie = loginRes.cookies.find((c) => c.name === "erp_session")!.value;

    const tbRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      cookies: { erp_session: cookie },
    });
    expect(tbRes.statusCode).toBe(200);
    const tb = tbRes.json();
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebit).toBeGreaterThan(0);
    expect(tb.totalCredit).toBe(tb.totalDebit);

    const bsRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/balance-sheet",
      cookies: { erp_session: cookie },
    });
    expect(bsRes.statusCode).toBe(200);
    expect(bsRes.json().isBalanced).toBe(true);

    const fyRes = await app.inject({
      method: "GET",
      url: "/api/accounting/fiscal-years",
      cookies: { erp_session: cookie },
    });
    expect(fyRes.statusCode).toBe(200);
    const currentYear = new Date().getUTCFullYear();
    const currentMonth = `${currentYear}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const currentFy = fyRes.json().fiscalYears.find((y: { name: string }) => y.name === `FY ${currentYear}`);
    const currentPeriod = currentFy?.periods.find((p: { name: string }) => p.name === currentMonth);
    expect(currentPeriod).toBeDefined();

    const lockRes = await app.inject({
      method: "POST",
      url: `/api/accounting/periods/${currentPeriod.id}/lock`,
      cookies: { erp_session: cookie },
    });
    expect(lockRes.statusCode).toBe(200);

    const acctRes = await app.inject({
      method: "GET",
      url: "/api/accounting/accounts",
      cookies: { erp_session: cookie },
    });
    const accounts = acctRes.json().accounts as Array<{ id: string; code: string }>;
    const cashId = accounts.find((a) => a.code === "1000")!.id;
    const equityId = accounts.find((a) => a.code === "3000")!.id;

    const blockedJe = await app.inject({
      method: "POST",
      url: "/api/accounting/journal-entries",
      cookies: { erp_session: cookie },
      payload: {
        memo: "Blocked backdated entry",
        lines: [
          { accountId: cashId, debit: 50, credit: 0 },
          { accountId: equityId, debit: 0, credit: 50 },
        ],
      },
    });
    expect(blockedJe.statusCode).toBe(400);
    expect(blockedJe.json().code).toBe("FISCAL_PERIOD_LOCKED");

    const unlockRes = await app.inject({
      method: "POST",
      url: `/api/accounting/periods/${currentPeriod.id}/unlock`,
      cookies: { erp_session: cookie },
    });
    expect(unlockRes.statusCode).toBe(200);
  });
});
