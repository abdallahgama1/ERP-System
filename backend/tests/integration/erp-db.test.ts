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
    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db, { reseed: false });

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

  it("enforces credit limits, maker-checker approvals, overdue sweep, and vendor bill PPV split", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const adminCookie = adminLogin.cookies.find((c) => c.name === "erp_session")!.value;

    const brList = await app.inject({ method: "GET", url: "/api/branches", cookies: { erp_session: adminCookie } });
    const hqId = brList.json().branches[0].id as string;
    const prodList = await app.inject({ method: "GET", url: "/api/products", cookies: { erp_session: adminCookie } });
    const productId = prodList.json().products[0].id as string;

    // 1. Customer credit-limit enforcement
    const cappedCustRes = await app.inject({
      method: "POST",
      url: "/api/customers",
      cookies: { erp_session: adminCookie },
      payload: { name: "Credit Capped Co", creditLimit: 250 },
    });
    expect(cappedCustRes.statusCode).toBe(201);
    const cappedCustId = cappedCustRes.json().customer.id as string;

    const overLimitSo = await app.inject({
      method: "POST",
      url: "/api/sales-orders",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId: cappedCustId,
        branchId: hqId,
        status: "Confirmed",
        lines: [{ productId, quantity: 3, unitPrice: 100 }],
      },
    });
    expect(overLimitSo.statusCode).toBe(400);
    expect(overLimitSo.json().code).toBe("CREDIT_LIMIT_EXCEEDED");

    // 2. Past-due invoice & overdue sweep worker
    const pastDueInv = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId: cappedCustId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2020-01-01",
        lines: [{ productId, quantity: 1, unitPrice: 100 }],
      },
    });
    expect(pastDueInv.statusCode).toBe(201);
    const pastDueInvId = pastDueInv.json().invoice.id as string;

    const sweepRes = await app.inject({
      method: "POST",
      url: "/api/admin/jobs/overdue-sweep",
      cookies: { erp_session: adminCookie },
    });
    expect(sweepRes.statusCode).toBe(200);
    expect(sweepRes.json().overdueInvoicesMarked).toBeGreaterThanOrEqual(1);

    const invAfterSweep = await app.inject({
      method: "GET",
      url: "/api/sales-invoices",
      cookies: { erp_session: adminCookie },
    });
    const overdueInv = invAfterSweep.json().invoices.find((i: { id: string }) => i.id === pastDueInvId);
    expect(overdueInv.status).toBe("Overdue");

    // 3. Maker-checker approval workflow (2nd user promoted to manager)
    const usersRes = await app.inject({ method: "GET", url: "/api/users", cookies: { erp_session: adminCookie } });
    const secondUser = usersRes.json().users.find((u: { email: string }) => u.email === "user@test.local");
    expect(secondUser).toBeDefined();

    const promoteRes = await app.inject({
      method: "PUT",
      url: `/api/users/${secondUser.id}/role`,
      cookies: { erp_session: adminCookie },
      payload: { role: "manager" },
    });
    expect(promoteRes.statusCode).toBe(200);

    const ruleRes = await app.inject({
      method: "PUT",
      url: "/api/approvals/rules",
      cookies: { erp_session: adminCookie },
      payload: {
        entityType: "purchase_order",
        minAmount: 500,
        requiredRole: "manager",
        isActive: true,
        description: "PO >= 500 requires manager/admin approval",
      },
    });
    expect(ruleRes.statusCode).toBe(200);

    const vendorsRes = await app.inject({ method: "GET", url: "/api/vendors", cookies: { erp_session: adminCookie } });
    const vendorId = vendorsRes.json().vendors[0].id as string;

    const pendingPoRes = await app.inject({
      method: "POST",
      url: "/api/purchase-orders",
      cookies: { erp_session: adminCookie },
      payload: {
        vendorId,
        branchId: hqId,
        status: "Issued",
        lines: [{ productId, quantity: 10, unitCost: 100 }],
      },
    });
    expect(pendingPoRes.statusCode).toBe(201);
    expect(pendingPoRes.json().purchaseOrder.status).toBe("Draft");
    expect(pendingPoRes.json().purchaseOrder.approvalStatus).toBe("pending");
    const pendingPoId = pendingPoRes.json().purchaseOrder.id as string;

    const reqListRes = await app.inject({
      method: "GET",
      url: "/api/approvals/requests",
      cookies: { erp_session: adminCookie },
    });
    const reqItem = reqListRes.json().requests.find((r: { entityId: string }) => r.entityId === pendingPoId);
    expect(reqItem).toBeDefined();

    // Admin cannot self-approve while manager exists
    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/approvals/requests/${reqItem.id}/decision`,
      cookies: { erp_session: adminCookie },
      payload: { decision: "approved", comment: "Self attempt" },
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().code).toBe("SELF_APPROVAL_FORBIDDEN");

    // Second user (manager) approves -> PO becomes Issued
    const mgrLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "user@test.local", password: "Password123!" },
    });
    const mgrCookie = mgrLogin.cookies.find((c) => c.name === "erp_session")!.value;

    const mgrApprove = await app.inject({
      method: "POST",
      url: `/api/approvals/requests/${reqItem.id}/decision`,
      cookies: { erp_session: mgrCookie },
      payload: { decision: "approved", comment: "Verified budget" },
    });
    expect(mgrApprove.statusCode).toBe(200);
    expect(mgrApprove.json().request.status).toBe("approved");

    // 4. Vendor Bill PPV proportional allocation (receive @ 100, bill @ 120 -> balanced GL)
    const rcvRes = await app.inject({
      method: "POST",
      url: "/api/purchase-receives",
      cookies: { erp_session: adminCookie },
      payload: {
        poId: pendingPoId,
        vendorId,
        branchId: hqId,
        lines: [{ productId, quantity: 10, unitCost: 100 }],
      },
    });
    expect(rcvRes.statusCode).toBe(201);
    const receiveId = rcvRes.json().receive.id as string;

    const ppvBillRes = await app.inject({
      method: "POST",
      url: "/api/vendor-bills",
      cookies: { erp_session: adminCookie },
      payload: {
        vendorId,
        branchId: hqId,
        poId: pendingPoId,
        receiveId,
        dueDate: "2026-12-31",
        lines: [{ productId, quantity: 10, unitCost: 120 }],
      },
    });
    expect(ppvBillRes.statusCode).toBe(201);

    const tbRes = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      cookies: { erp_session: adminCookie },
    });
    expect(tbRes.statusCode).toBe(200);
    expect(tbRes.json().isBalanced).toBe(true);
  });

  it("enforces FEFO lot picking, expiry blocking, and serial lifecycle tracing", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const adminCookie = loginRes.cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
    });
    const allBranches = branchesRes.json().branches as Array<{ id: string }>;
    const hqId = allBranches[0].id;
    const retailId = allBranches[1].id;

    const vendorRes = await app.inject({
      method: "POST",
      url: "/api/vendors",
      cookies: { erp_session: adminCookie },
      payload: { name: "Pharma & Hardware Vendor" },
    });
    const vendorId = vendorRes.json().vendor.id as string;

    const custRes = await app.inject({
      method: "POST",
      url: "/api/customers",
      cookies: { erp_session: adminCookie },
      payload: { name: "D2 Buyer", creditLimit: null },
    });
    const customerId = custRes.json().customer.id as string;

    // 1. FEFO Lot Tracking + Expiry Blocking + Overdue/Expiry Sweep + Write-Off
    const lotProdRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "LOT-MED-01",
        name: "Vaccine Vial",
        costPrice: 10,
        sellingPrice: 30,
        trackingMode: "lot",
        requiresExpiry: true,
        pickingStrategy: "FEFO",
      },
    });
    expect(lotProdRes.statusCode).toBe(201);
    const lotProdId = lotProdRes.json().product.id as string;

    const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const soonDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const laterDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();

    for (const [lotNumber, expiryDate, unitCost] of [
      ["LOT-EXPIRED", pastDate, 10],
      ["LOT-SOON", soonDate, 12],
      ["LOT-LATER", laterDate, 15],
    ] as const) {
      const rcv = await app.inject({
        method: "POST",
        url: "/api/purchase-receives",
        cookies: { erp_session: adminCookie },
        payload: {
          vendorId,
          branchId: hqId,
          lines: [{ productId: lotProdId, quantity: 5, unitCost, lotNumber, expiryDate }],
        },
      });
      expect(rcv.statusCode).toBe(201);
    }

    // Sweep must flag both expired and expiring-soon lots
    const sweepRes = await app.inject({
      method: "POST",
      url: "/api/admin/jobs/overdue-sweep",
      cookies: { erp_session: adminCookie },
    });
    expect(sweepRes.statusCode).toBe(200);
    expect(sweepRes.json().expiredLotsAlerted).toBeGreaterThanOrEqual(1);
    expect(sweepRes.json().expiringLotsAlerted).toBeGreaterThanOrEqual(1);

    // Selling 6 units must auto-pick all 5 from LOT-SOON and 1 from LOT-LATER (skipping LOT-EXPIRED!)
    const fefoInv = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId: lotProdId, quantity: 6, unitPrice: 30 }],
      },
    });
    expect(fefoInv.statusCode).toBe(201);

    const lotsAfterSale = (
      await app.inject({
        method: "GET",
        url: `/api/tracking/lots?branchId=${hqId}&productId=${lotProdId}&includeZero=true`,
        cookies: { erp_session: adminCookie },
      })
    ).json().lots as Array<{ lotNumber: string; qtyOnHand: number }>;

    expect(lotsAfterSale.find((l) => l.lotNumber === "LOT-EXPIRED")?.qtyOnHand).toBe(5);
    expect(lotsAfterSale.find((l) => l.lotNumber === "LOT-SOON")?.qtyOnHand).toBe(0);
    expect(lotsAfterSale.find((l) => l.lotNumber === "LOT-LATER")?.qtyOnHand).toBe(4);

    // Trying to sell 5 more (only 4 non-expired remain) must fail with LOT_EXPIRED
    const blockedSale = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId,
        branchId: hqId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId: lotProdId, quantity: 5, unitPrice: 30 }],
      },
    });
    expect(blockedSale.statusCode).toBe(400);
    expect(blockedSale.json().code).toBe("LOT_EXPIRED");

    // Writing off the 5 expired units explicitly must succeed
    const woExpired = await app.inject({
      method: "POST",
      url: "/api/write-offs",
      cookies: { erp_session: adminCookie },
      payload: {
        branchId: hqId,
        reason: "Expired",
        lines: [{ productId: lotProdId, quantity: 5, lotAllocations: [{ lotNumber: "LOT-EXPIRED", quantity: 5 }] }],
      },
    });
    expect(woExpired.statusCode).toBe(201);

    // 2. Serial Number Uniqueness, Transfer & Lifecycle Trace
    const serialProdRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "SER-LAP-01",
        name: "Enterprise Laptop",
        costPrice: 800,
        sellingPrice: 1200,
        trackingMode: "serial",
      },
    });
    expect(serialProdRes.statusCode).toBe(201);
    const serialProdId = serialProdRes.json().product.id as string;

    const rcvSerial = await app.inject({
      method: "POST",
      url: "/api/purchase-receives",
      cookies: { erp_session: adminCookie },
      payload: {
        vendorId,
        branchId: hqId,
        lines: [{ productId: serialProdId, quantity: 2, unitCost: 800, serialNumbers: ["SN-D2-001", "SN-D2-002"] }],
      },
    });
    expect(rcvSerial.statusCode).toBe(201);

    // Duplicate serial rejected with 409
    const dupSerial = await app.inject({
      method: "POST",
      url: "/api/purchase-receives",
      cookies: { erp_session: adminCookie },
      payload: {
        vendorId,
        branchId: hqId,
        lines: [{ productId: serialProdId, quantity: 1, unitCost: 800, serialNumbers: ["SN-D2-001"] }],
      },
    });
    expect(dupSerial.statusCode).toBe(409);
    expect(dupSerial.json().code).toBe("DUPLICATE_SERIAL");

    // Transfer SN-D2-001 to Retail and receive it
    const trSerial = await app.inject({
      method: "POST",
      url: "/api/transfers",
      cookies: { erp_session: adminCookie },
      payload: {
        fromBranchId: hqId,
        toBranchId: retailId,
        status: "In Transit",
        lines: [{ productId: serialProdId, quantity: 1, serialNumbers: ["SN-D2-001"] }],
      },
    });
    expect(trSerial.statusCode).toBe(201);
    const trId = trSerial.json().transfer.id as string;

    const rcvTrSerial = await app.inject({
      method: "POST",
      url: `/api/transfers/${trId}/receive`,
      cookies: { erp_session: adminCookie },
      payload: { items: [{ productId: serialProdId, qtyReceived: 1 }] },
    });
    expect(rcvTrSerial.statusCode).toBe(200);

    // Sell SN-D2-001 at Retail and trace its lifecycle
    const sellSerial = await app.inject({
      method: "POST",
      url: "/api/sales-invoices",
      cookies: { erp_session: adminCookie },
      payload: {
        customerId,
        branchId: retailId,
        status: "Sent",
        dueDate: "2026-12-31",
        lines: [{ productId: serialProdId, quantity: 1, unitPrice: 1200, serialNumbers: ["SN-D2-001"] }],
      },
    });
    expect(sellSerial.statusCode).toBe(201);

    const serialsList = (
      await app.inject({
        method: "GET",
        url: "/api/tracking/serials?search=SN-D2-001",
        cookies: { erp_session: adminCookie },
      })
    ).json().serials as Array<{ id: string; status: string }>;
    expect(serialsList).toHaveLength(1);
    expect(serialsList[0].status).toBe("sold");

    const traceRes = await app.inject({
      method: "GET",
      url: `/api/tracking/serials/${serialsList[0].id}/trace`,
      cookies: { erp_session: adminCookie },
    });
    expect(traceRes.statusCode).toBe(200);
    expect(traceRes.json().history.length).toBe(4); // purchase_receive, transfer_out, transfer_in, sales_invoice
  });

  it("enforces BOM cycle detection and balanced Work Order WIP GL across completion & cancellation", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "admin@test.local", password: "Password123!" },
    });
    const adminCookie = loginRes.cookies.find((c) => c.name === "erp_session")!.value;

    const branchesRes = await app.inject({
      method: "GET",
      url: "/api/branches",
      cookies: { erp_session: adminCookie },
    });
    const hqId = (branchesRes.json().branches as Array<{ id: string }>)[0].id;

    // 3. Manufacturing BOM Cycle Detection & Work Order WIP GL Lifecycle
    const rawRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "RAW-ALU-01",
        name: "Aluminum Sheet",
        costPrice: 25,
        sellingPrice: 40,
        initialStock: [{ branchId: hqId, quantity: 100, unitCost: 25 }],
      },
    });
    const rawId = rawRes.json().product.id as string;

    const fgRes = await app.inject({
      method: "POST",
      url: "/api/products",
      cookies: { erp_session: adminCookie },
      payload: {
        sku: "FG-CHAS-01",
        name: "Machined Chassis",
        itemType: "manufactured",
        costPrice: 50,
        sellingPrice: 150,
      },
    });
    const fgId = fgRes.json().product.id as string;

    const bomRes = await app.inject({
      method: "POST",
      url: "/api/manufacturing/boms",
      cookies: { erp_session: adminCookie },
      payload: {
        productId: fgId,
        name: "Chassis BOM v1",
        outputQty: 1,
        components: [{ componentProductId: rawId, quantity: 2, scrapPercent: 0 }],
      },
    });
    expect(bomRes.statusCode).toBe(201);
    const bomId = bomRes.json().bom.id as string;

    // Circular BOM (RAW depends on FG) must fail with BOM_CYCLE_DETECTED
    const cycleRes = await app.inject({
      method: "POST",
      url: "/api/manufacturing/boms",
      cookies: { erp_session: adminCookie },
      payload: {
        productId: rawId,
        name: "Circular Bad BOM",
        outputQty: 1,
        components: [{ componentProductId: fgId, quantity: 1 }],
      },
    });
    expect(cycleRes.statusCode).toBe(400);
    expect(cycleRes.json().code).toBe("BOM_CYCLE_DETECTED");

    // Work Order #1: 5 units -> Issue -> Partial Complete (2) -> Final Complete (3)
    const wo1Res = await app.inject({
      method: "POST",
      url: "/api/manufacturing/work-orders",
      cookies: { erp_session: adminCookie },
      payload: { bomId, branchId: hqId, plannedQty: 5 },
    });
    expect(wo1Res.statusCode).toBe(201);
    const wo1Id = wo1Res.json().workOrder.id as string;

    const issue1 = await app.inject({
      method: "POST",
      url: `/api/manufacturing/work-orders/${wo1Id}/issue`,
      cookies: { erp_session: adminCookie },
      payload: {},
    });
    expect(issue1.statusCode).toBe(200);

    const comp1a = await app.inject({
      method: "POST",
      url: `/api/manufacturing/work-orders/${wo1Id}/complete`,
      cookies: { erp_session: adminCookie },
      payload: { qtyCompleted: 2 },
    });
    expect(comp1a.statusCode).toBe(200);
    expect(comp1a.json().workOrder.status).toBe("In Progress");

    const comp1b = await app.inject({
      method: "POST",
      url: `/api/manufacturing/work-orders/${wo1Id}/complete`,
      cookies: { erp_session: adminCookie },
      payload: { qtyCompleted: 3 },
    });
    expect(comp1b.statusCode).toBe(200);
    expect(comp1b.json().workOrder.status).toBe("Completed");

    // Work Order #2: 2 units -> Issue -> Cancel (reverses WIP cleanly back to 0)
    const wo2Res = await app.inject({
      method: "POST",
      url: "/api/manufacturing/work-orders",
      cookies: { erp_session: adminCookie },
      payload: { bomId, branchId: hqId, plannedQty: 2 },
    });
    const wo2Id = wo2Res.json().workOrder.id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/manufacturing/work-orders/${wo2Id}/issue`,
          cookies: { erp_session: adminCookie },
          payload: {},
        })
      ).statusCode
    ).toBe(200);

    const cancel2 = await app.inject({
      method: "POST",
      url: `/api/manufacturing/work-orders/${wo2Id}/cancel`,
      cookies: { erp_session: adminCookie },
      payload: { reason: "Order cancelled" },
    });
    expect(cancel2.statusCode).toBe(200);
    expect(cancel2.json().workOrder.status).toBe("Cancelled");

    // Verify Trial Balance is balanced AND 1220 WIP net balance === 0
    const tbFinal = await app.inject({
      method: "GET",
      url: "/api/accounting/reports/trial-balance",
      cookies: { erp_session: adminCookie },
    });
    expect(tbFinal.statusCode).toBe(200);
    const tbBody = tbFinal.json();
    expect(tbBody.isBalanced).toBe(true);
    const wipRow = (tbBody.rows as Array<{ code: string; debit: number; credit: number }>).find((r) => r.code === "1220");
    expect(wipRow).toBeTruthy();
    expect(Math.abs(wipRow!.debit - wipRow!.credit)).toBeLessThan(0.01);
  });
});
