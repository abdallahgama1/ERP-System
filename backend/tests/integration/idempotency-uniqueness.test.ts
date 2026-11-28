import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

function authHeaders(res: { headers: Record<string, unknown> }, extra: Record<string, string> = {}) {
  const session = extractCookie(res, "erp_session");
  const csrfPair = extractCookie(res, "erp_csrf");
  const csrf = csrfPair ? decodeURIComponent(csrfPair.slice("erp_csrf=".length)) : "";
  return {
    cookie: csrf ? `${session}; erp_csrf=${csrf}` : session,
    ...(csrf ? { "x-csrf-token": csrf } : {}),
    ...extra,
  };
}

const describeWithDb = testDbUrl ? describe : describe.skip;

describeWithDb("Run B1: Backend Idempotency, Normalized Unique Constraints, TRN Warning & Dedupe Tool", () => {
  let app: FastifyInstance;
  let db: AppDatabase;
  let adminHeaders: Record<string, string>;
  let hqBranchId: string;
  let secondBranchId: string;
  let productId: string;
  let customerId: string;
  let cashAccountId: string;
  let revenueAccountId: string;
  let prevIdempRequired: string | undefined;
  let prevInProgressTimeout: string | undefined;

  beforeAll(async () => {
    const { buildApp } = await import("../../src/app.ts");
    const { getDb } = await import("../../src/db/index.ts");
    const { assertTestDatabaseName } = await import("../helpers/db-reset.ts");
    db = getDb();
    await assertTestDatabaseName(db, testDbUrl);
    app = await buildApp({ logger: false, enableRateLimit: false });
    // Register a test-only 500 route to deterministically verify 5xx responses are never cached
    let failOnce = true;
    app.post("/api/_test/flaky-idemp", async (_req, reply) => {
      if (failOnce) {
        failOnce = false;
        return reply.status(500).send({ message: "Simulated transient 500 failure", code: "SIMULATED_500" });
      }
      return reply.status(201).send({ ok: true, createdId: "flaky-ok-1", secret: "must-not-be-stored" });
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    const { closeDatabase } = await import("../../src/db/index.ts");
    await closeDatabase();
  });

  beforeEach(async () => {
    prevIdempRequired = process.env.IDEMPOTENCY_REQUIRED;
    prevInProgressTimeout = process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS;
    delete process.env.IDEMPOTENCY_REQUIRED;
    delete process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS;

    const { resetTestDatabase } = await import("../helpers/db-reset.ts");
    await resetTestDatabase(db);

    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { name: "B1 Admin", email: "b1-admin@test.local", password: "StrongPassword123!" },
    });
    expect(signup.statusCode).toBe(201);
    adminHeaders = authHeaders(signup);

    const branchesRes = await app.inject({ method: "GET", url: "/api/branches", headers: adminHeaders });
    hqBranchId = branchesRes.json().branches[0].id;

    const b2 = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: adminHeaders,
      payload: { name: "Alexandria Store", branchType: "retail", location: "Alex" },
    });
    expect(b2.statusCode).toBe(201);
    secondBranchId = b2.json().branch.id;

    const prod = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: {
        sku: "B1-ITEM-01",
        barcode: "6220000111222",
        name: "Idempotent Widget",
        costPrice: 50,
        sellingPrice: 100,
        initialStock: [{ branchId: hqBranchId, quantity: 200, unitCost: 50 }],
      },
    });
    expect(prod.statusCode).toBe(201);
    productId = prod.json().product.id;

    const cust = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: adminHeaders,
      payload: { name: "Nile Trading", taxNumber: "100-200-300" },
    });
    expect(cust.statusCode).toBe(201);
    customerId = cust.json().customer.id;

    const coaRes = await app.inject({ method: "GET", url: "/api/accounting/accounts", headers: adminHeaders });
    const accounts = coaRes.json().accounts as Array<{ id: string; code: string }>;
    cashAccountId = accounts.find((a) => a.code === "1000")!.id;
    revenueAccountId = accounts.find((a) => a.code === "4000")!.id;
  });

  afterEach(() => {
    if (prevIdempRequired === undefined) delete process.env.IDEMPOTENCY_REQUIRED;
    else process.env.IDEMPOTENCY_REQUIRED = prevIdempRequired;
    if (prevInProgressTimeout === undefined) delete process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS;
    else process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS = prevInProgressTimeout;
  });

  it("1. serializes 10 concurrent identical POST requests on branches, products, invoices, payments, POS checkout, journals, and transfers to exactly ONE record each", async () => {
    const {
      branches,
      journalEntries,
      posShifts,
      products,
      receivedPayments,
      salesInvoices,
      stockTransfers,
    } = await import("../../drizzle/schema.ts");

    // 1A. 10 concurrent POST /api/branches
    const branchKey = `br-${randomUUID()}`;
    const branchResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/branches",
          headers: { ...adminHeaders, "idempotency-key": branchKey },
          payload: { name: "New Cairo Hub", location: "5th Settlement", branchType: "retail" },
        })
      )
    );
    expect(branchResponses.every((r) => r.statusCode === 201)).toBe(true);
    const branchIds = new Set(branchResponses.map((r) => r.json().branch.id));
    expect(branchIds.size).toBe(1);
    const matchingBranches = await db
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.name, "New Cairo Hub"));
    expect(matchingBranches).toHaveLength(1);

    // 1B. 10 concurrent POST /api/products
    const prodKey = `prod-${randomUUID()}`;
    const prodResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/products",
          headers: { ...adminHeaders, "idempotency-key": prodKey },
          payload: { sku: "CONC-SKU-99", barcode: "6229999888777", name: "Concurrent Product", sellingPrice: 25 },
        })
      )
    );
    expect(prodResponses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(prodResponses.map((r) => r.json().product.id)).size).toBe(1);
    const matchingProds = await db.select({ id: products.id }).from(products).where(eq(products.sku, "CONC-SKU-99"));
    expect(matchingProds).toHaveLength(1);

    // 1C. 10 concurrent POST /api/sales-invoices
    const invKey = `inv-${randomUUID()}`;
    const invPayload = {
      customerId,
      branchId: hqBranchId,
      dueDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
      lines: [{ productId, description: "Widget", quantity: 2, unitPrice: 100, taxRate: 14 }],
    };
    const invResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/sales-invoices",
          headers: { ...adminHeaders, "idempotency-key": invKey },
          payload: invPayload,
        })
      )
    );
    expect(invResponses.every((r) => r.statusCode === 201)).toBe(true);
    const createdInvId = invResponses[0]!.json().invoice.id as string;
    expect(new Set(invResponses.map((r) => r.json().invoice.id)).size).toBe(1);
    const invRows = await db.select({ id: salesInvoices.id }).from(salesInvoices);
    expect(invRows).toHaveLength(1);

    // 1D. 10 concurrent POST /api/received-payments
    const payKey = `pay-${randomUUID()}`;
    const payPayload = {
      customerId,
      branchId: hqBranchId,
      amount: 228,
      paymentMethod: "Cash",
      allocations: [{ invoiceId: createdInvId, amount: 228 }],
    };
    const payResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/received-payments",
          headers: { ...adminHeaders, "idempotency-key": payKey },
          payload: payPayload,
        })
      )
    );
    expect(payResponses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(payResponses.map((r) => r.json().payment.id)).size).toBe(1);
    const payRows = await db.select({ id: receivedPayments.id }).from(receivedPayments);
    expect(payRows).toHaveLength(1);

    // 1E. 10 concurrent POST /api/pos/checkout
    const termRes = await app.inject({
      method: "POST",
      url: "/api/pos/terminals",
      headers: adminHeaders,
      payload: { branchId: hqBranchId, code: "POS-B1", name: "Register B1" },
    });
    expect(termRes.statusCode).toBe(201);
    const terminalId = termRes.json().terminal.id as string;

    const shiftRes = await app.inject({
      method: "POST",
      url: "/api/pos/shifts/open",
      headers: adminHeaders,
      payload: { terminalId, openingFloat: 500 },
    });
    expect(shiftRes.statusCode).toBe(201);
    const shiftId = shiftRes.json().shift.id as string;
    expect((await db.select({ id: posShifts.id }).from(posShifts)).length).toBe(1);

    const posKey = `pos-${randomUUID()}`;
    const posPayload = {
      terminalId,
      shiftId,
      lines: [{ productId, quantity: 1, unitPrice: 100, taxRate: 0 }],
      tenders: [{ method: "cash", amount: 100 }],
    };
    const posResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/pos/checkout",
          headers: { ...adminHeaders, "idempotency-key": posKey },
          payload: posPayload,
        })
      )
    );
    expect(posResponses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(posResponses.map((r) => r.json().receipt.invoiceId)).size).toBe(1);
    // Total invoices should be 2 (1 B2B invoice + 1 POS checkout)
    expect((await db.select({ id: salesInvoices.id }).from(salesInvoices)).length).toBe(2);

    // 1F. 10 concurrent POST /api/accounting/journal-entries
    const jeKey = `je-${randomUUID()}`;
    const jePayload = {
      entryDate: new Date().toISOString().slice(0, 10),
      memo: "Concurrent manual JE",
      lines: [
        { accountId: cashAccountId, debit: 500, credit: 0 },
        { accountId: revenueAccountId, debit: 0, credit: 500 },
      ],
    };
    const jeResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/accounting/journal-entries",
          headers: { ...adminHeaders, "idempotency-key": jeKey },
          payload: jePayload,
        })
      )
    );
    expect(jeResponses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(jeResponses.map((r) => r.json().entry.id)).size).toBe(1);
    const manualJes = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.memo, "Concurrent manual JE"));
    expect(manualJes).toHaveLength(1);

    // 1G. 10 concurrent POST /api/transfers
    const trfKey = `trf-${randomUUID()}`;
    const trfPayload = {
      fromBranchId: hqBranchId,
      toBranchId: secondBranchId,
      status: "Draft",
      lines: [{ productId, quantity: 5 }],
    };
    const trfResponses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/api/transfers",
          headers: { ...adminHeaders, "idempotency-key": trfKey },
          payload: trfPayload,
        })
      )
    );
    expect(trfResponses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(trfResponses.map((r) => r.json().transfer.id)).size).toBe(1);
    expect((await db.select({ id: stockTransfers.id }).from(stockTransfers)).length).toBe(1);
  });

  it("2. enforces 422 payload mismatch, does not cache 5xx, scrubs secrets, recovers stale in_progress, and respects IDEMPOTENCY_REQUIRED", async () => {
    const { idempotencyKeys } = await import("../../drizzle/schema.ts");

    // 2A. 422 mismatch when same key is reused with different payload
    const key1 = `mismatch-${randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: { ...adminHeaders, "idempotency-key": key1 },
      payload: { name: "Maadi Store", location: "Maadi" },
    });
    expect(first.statusCode).toBe(201);

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: { ...adminHeaders, "idempotency-key": key1 },
      payload: { name: "Zamalek Store", location: "Zamalek" },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().code).toBe("IDEMPOTENCY_KEY_REUSE_MISMATCH");
    expect(mismatch.json().details.messageAr).toBeTruthy();

    // Verify 24-hour expiry was set on stored key
    const [stored] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key1))
      .limit(1);
    expect(stored).toBeDefined();
    expect(stored!.state).toBe("completed");
    const ttlHours = (stored!.expiresAt!.getTime() - stored!.createdAt.getTime()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(23.5);
    expect(ttlHours).toBeLessThan(24.5);

    // 2B. 5xx failure is NOT cached; retry with the same key succeeds & scrubs secret fields
    const flakyKey = `flaky-${randomUUID()}`;
    const failRes = await app.inject({
      method: "POST",
      url: "/api/_test/flaky-idemp",
      headers: { ...adminHeaders, "idempotency-key": flakyKey },
      payload: { step: 1 },
    });
    expect(failRes.statusCode).toBe(500);
    const afterFailRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, flakyKey));
    expect(afterFailRows).toHaveLength(0);

    const retryOk = await app.inject({
      method: "POST",
      url: "/api/_test/flaky-idemp",
      headers: { ...adminHeaders, "idempotency-key": flakyKey },
      payload: { step: 1 },
    });
    expect(retryOk.statusCode).toBe(201);
    const [storedFlaky] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, flakyKey)).limit(1);
    expect(storedFlaky!.state).toBe("completed");
    expect(JSON.stringify(storedFlaky!.responseBody)).not.toContain("must-not-be-stored");

    // 2C. Stale in_progress record is recovered cleanly after lockedUntil elapses
    const { computeIdempotencyRequestHash } = await import("../../src/middleware/idempotency.ts");
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", headers: adminHeaders });
    const me = meRes.json().user as { id: string; activeCompanyId: string };
    const staleKey = `stale-${randomUUID()}`;
    const stalePayload = { name: "Heliopolis Branch", location: "Heliopolis" };
    const reqHash = computeIdempotencyRequestHash({
      method: "POST",
      path: "/api/branches",
      query: {},
      body: stalePayload,
    });
    await db.insert(idempotencyKeys).values({
      companyId: me.activeCompanyId,
      userId: me.id,
      key: staleKey,
      method: "POST",
      path: "/api/branches",
      requestHash: reqHash,
      state: "in_progress",
      statusCode: null,
      responseBody: null,
      lockedUntil: new Date(Date.now() - 5_000), // already expired lock!
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });

    const recoveredRes = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: { ...adminHeaders, "idempotency-key": staleKey },
      payload: stalePayload,
    });
    expect(recoveredRes.statusCode).toBe(201);
    const replayedRes = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: { ...adminHeaders, "idempotency-key": staleKey },
      payload: stalePayload,
    });
    expect(replayedRes.statusCode).toBe(201);
    expect(replayedRes.headers["idempotency-replayed"]).toBe("true");
    expect(replayedRes.json().branch.id).toBe(recoveredRes.json().branch.id);

    // 2D. IDEMPOTENCY_REQUIRED=true enforces key on create/financial POSTs, excludes dryRun previews & auth
    process.env.IDEMPOTENCY_REQUIRED = "true";
    const missingKeyBranch = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: adminHeaders,
      payload: { name: "Should Fail Without Key", location: "Cairo" },
    });
    expect(missingKeyBranch.statusCode).toBe(400);
    expect(missingKeyBranch.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    // dryRun=true import preview still allowed without Idempotency-Key
    const dryRunRes = await app.inject({
      method: "POST",
      url: "/api/imports/customers",
      headers: adminHeaders,
      payload: { dryRun: true, csv: "code,name\nCUS-DRY-1,Dry Customer\n" },
    });
    expect(dryRunRes.statusCode).toBe(200);

    // dryRun=false import commit requires Idempotency-Key
    const commitNoKey = await app.inject({
      method: "POST",
      url: "/api/imports/customers",
      headers: adminHeaders,
      payload: { dryRun: false, csv: "code,name\nCUS-DRY-1,Dry Customer\n" },
    });
    expect(commitNoKey.statusCode).toBe(400);
    expect(commitNoKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("3. enforces normalized natural-key unique constraints with EN/AR 409 errors and soft DUPLICATE_TAX_NUMBER_WARNING with confirmDuplicate override", async () => {
    // 3A. Branch name normalized case/whitespace uniqueness -> 409 DUPLICATE_BRANCH_NAME
    const dupBranchName = await app.inject({
      method: "POST",
      url: "/api/branches",
      headers: adminHeaders,
      payload: { name: "  alexandria store  ", location: "Alex 2" },
    });
    expect(dupBranchName.statusCode).toBe(409);
    expect(dupBranchName.json().code).toBe("DUPLICATE_BRANCH_NAME");
    expect(dupBranchName.json().details.messageAr).toBeTruthy();

    // 3B. Product normalized SKU and non-empty barcode uniqueness -> 409
    const dupSku = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: { sku: "  b1-item-01 ", name: "Another Name" },
    });
    expect(dupSku.statusCode).toBe(409);

    const dupBarcode = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: { sku: "B1-ITEM-02", barcode: " 6220000111222 ", name: "Dup Barcode Product" },
    });
    expect(dupBarcode.statusCode).toBe(409);
    expect(dupBarcode.json().code).toBe("DUPLICATE_PRODUCT_BARCODE");
    expect(dupBarcode.json().details.messageAr).toBeTruthy();

    // Multiple products with empty/null barcode are allowed
    const emptyBc1 = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: { sku: "B1-NOBC-1", barcode: null, name: "No Barcode 1" },
    });
    const emptyBc2 = await app.inject({
      method: "POST",
      url: "/api/products",
      headers: adminHeaders,
      payload: { sku: "B1-NOBC-2", barcode: "", name: "No Barcode 2" },
    });
    expect(emptyBc1.statusCode).toBe(201);
    expect(emptyBc2.statusCode).toBe(201);

    // 3C. Customer TRN soft warning -> 409 DUPLICATE_TAX_NUMBER_WARNING, overridable with confirmDuplicate=true
    const dupCustTax = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: adminHeaders,
      payload: { name: "Nile Trading Branch 2", taxNumber: " 100-200-300 " },
    });
    expect(dupCustTax.statusCode).toBe(409);
    expect(dupCustTax.json().code).toBe("DUPLICATE_TAX_NUMBER_WARNING");
    expect(dupCustTax.json().details.canOverride).toBe(true);
    expect(dupCustTax.json().details.messageAr).toBeTruthy();

    const overrideCust = await app.inject({
      method: "POST",
      url: "/api/customers",
      headers: adminHeaders,
      payload: { name: "Nile Trading Branch 2", taxNumber: "100-200-300", confirmDuplicate: true },
    });
    expect(overrideCust.statusCode).toBe(201);

    // 3D. Vendor TRN soft warning -> 409 DUPLICATE_TAX_NUMBER_WARNING, overridable with confirmDuplicate=true
    const v1 = await app.inject({
      method: "POST",
      url: "/api/vendors",
      headers: adminHeaders,
      payload: { name: "Delta Supply", taxNumber: "999-888-777" },
    });
    expect(v1.statusCode).toBe(201);

    const dupVendTax = await app.inject({
      method: "POST",
      url: "/api/vendors",
      headers: adminHeaders,
      payload: { name: "Delta Supply Division 2", taxNumber: "999-888-777" },
    });
    expect(dupVendTax.statusCode).toBe(409);
    expect(dupVendTax.json().code).toBe("DUPLICATE_TAX_NUMBER_WARNING");

    const overrideVend = await app.inject({
      method: "POST",
      url: "/api/vendors",
      headers: adminHeaders,
      payload: { name: "Delta Supply Division 2", taxNumber: "999-888-777", confirmDuplicate: true },
    });
    expect(overrideVend.statusCode).toBe(201);

    // 3E. Cost center & POS terminal normalized name uniqueness
    const cc1 = await app.inject({
      method: "POST",
      url: "/api/accounting/cost-centers",
      headers: adminHeaders,
      payload: { code: "CC-01", name: "Operations" },
    });
    expect(cc1.statusCode).toBe(201);
    const ccDup = await app.inject({
      method: "POST",
      url: "/api/accounting/cost-centers",
      headers: adminHeaders,
      payload: { code: "CC-02", name: " operations " },
    });
    expect(ccDup.statusCode).toBe(409);
    expect(ccDup.json().code).toBe("DUPLICATE_COST_CENTER_NAME");
  });

  it("4. scripts/deduplicate-records.mjs keeps oldest, deletes only zero-history duplicates, refuses referenced rows & prod without backup flag, and preserves audit hash chain", async () => {
    const dedupeUrl = pathToFileURL(path.resolve(__dirname, "../../../scripts/deduplicate-records.mjs")).href;
    const { runDeduplicate } = (await import(dedupeUrl)) as {
      runDeduplicate: (opts: Record<string, unknown>) => Promise<{
        clean: boolean;
        duplicateGroupCount: number;
        deleted: Array<{ id: string; code: string | null }>;
        refused: Array<{ id: string; blockers: Array<{ table: string }> }>;
      }>;
    };

    // Refuses --apply on remote/production URL without --i-have-a-backup
    await expect(
      runDeduplicate({
        databaseUrl: "postgresql://erp:pw@prod-db.example.com:5432/erp",
        apply: true,
        iHaveABackup: false,
      })
    ).rejects.toThrow(/--i-have-a-backup/);

    // Simulate legacy pre-0014 duplicates by temporarily dropping branches_company_name_norm_uq
    const { branches, branchProducts, DEFAULT_COMPANY_ID } = await import("../../drizzle/schema.ts");
    await db.execute(sql`DROP INDEX IF EXISTS "branches_company_name_norm_uq"`);
    try {
      const t1 = new Date("2026-01-01T10:00:00Z");
      const t2 = new Date("2026-01-01T10:00:02Z");
      const t3 = new Date("2026-01-01T10:00:04Z");

      const [oldest] = await db
        .insert(branches)
        .values({ companyId: DEFAULT_COMPANY_ID, code: "DUP-OLD", name: "التجمع", createdAt: t1 })
        .returning();
      const [unusedDup] = await db
        .insert(branches)
        .values({ companyId: DEFAULT_COMPANY_ID, code: "DUP-UNUSED", name: " التجمع ", createdAt: t2 })
        .returning();
      const [referencedDup] = await db
        .insert(branches)
        .values({ companyId: DEFAULT_COMPANY_ID, code: "DUP-USED", name: "التجمع", createdAt: t3 })
        .returning();

      // Give referencedDup real inventory history so dedupe MUST refuse to delete it
      await db.insert(branchProducts).values({
        companyId: DEFAULT_COMPANY_ID,
        branchId: referencedDup!.id,
        productId,
        qtyOnHand: "10",
        avgCost: "50",
      });

      // Dry-run finds the group and deletes nothing
      const dryReport = await runDeduplicate({ databaseUrl: testDbUrl, apply: false });
      expect(dryReport.clean).toBe(false);
      expect(dryReport.duplicateGroupCount).toBe(1);
      expect(dryReport.deleted).toHaveLength(0);

      // Apply deletes ONLY unusedDup, keeps oldest, and refuses referencedDup
      const applyReport = await runDeduplicate({ databaseUrl: testDbUrl, apply: true });
      expect(applyReport.deleted.map((d) => d.id)).toEqual([unusedDup!.id]);
      expect(applyReport.refused.map((r) => r.id)).toEqual([referencedDup!.id]);

      const remaining = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(eq(branches.companyId, DEFAULT_COMPANY_ID), sql`lower(btrim(${branches.name})) = 'التجمع'`));
      expect(remaining.map((r) => r.id).sort()).toEqual([oldest!.id, referencedDup!.id].sort());

      // Audit hash chain remains 100% valid after dedupe logged ops.duplicate_removed
      const verify = await app.inject({ method: "GET", url: "/api/audit-logs/verify", headers: adminHeaders });
      expect(verify.statusCode).toBe(200);
      expect(verify.json().valid).toBe(true);

      // Clean up test rows before restoring the unique index
      await db.delete(branchProducts).where(eq(branchProducts.branchId, referencedDup!.id));
      await db.delete(branches).where(eq(branches.id, referencedDup!.id));
    } finally {
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "branches_company_name_norm_uq" ON "branches" USING btree ("company_id", lower(btrim("name")))`
      );
    }
  }, 30_000);
});
