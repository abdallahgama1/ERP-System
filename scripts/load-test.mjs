import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { register } from "tsx/esm/api";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

dotenv.config({ path: path.resolve(repoRoot, "backend/.env") });

const stripQuotes = (value) => (value ?? "").trim().replace(/^['"]|['"]$/g, "");
const testDbUrl = stripQuotes(process.env.TEST_DATABASE_URL);
const fallbackDbUrl = stripQuotes(process.env.DATABASE_URL);
const targetDbUrl = testDbUrl || fallbackDbUrl;

if (!targetDbUrl) {
  console.error("ERROR: TEST_DATABASE_URL or DATABASE_URL must be configured in backend/.env");
  process.exit(1);
}

process.env.DATABASE_URL = targetDbUrl;
process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "true";

const unregisterTsx = register();

function computePercentiles(samplesMs) {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pick = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[idx] * 100) / 100;
  };
  const avg = Math.round((sorted.reduce((s, v) => s + v, 0) / sorted.length) * 100) / 100;
  return {
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    avg,
  };
}

async function main() {
  const { sql } = await import("drizzle-orm");
  const { buildApp } = await import("../backend/src/app.ts");
  const { closeDatabase, getDb } = await import("../backend/src/db/index.ts");

  const app = await buildApp({ logger: false });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const db = getDb();

  try {
    if (testDbUrl) {
      const expectedDb = new URL(testDbUrl).pathname.replace(/^\//, "");
      const check = await db.execute(sql`SELECT current_database() AS db`);
      const activeDb = check[0]?.db;
      if (activeDb !== expectedDb) {
        throw new Error(`Refusing to run destructive load test against '${activeDb}' instead of '${expectedDb}'`);
      }

      await db.execute(
        sql.raw(`TRUNCATE TABLE
          fixed_asset_depreciation_entries, fixed_assets,
          expense_claim_lines, expense_claims, bank_statement_lines, bank_statements,
          treasury_transfers, treasury_accounts, cost_centers,
          auth_lockouts, document_attachments, user_saved_views, user_mfa, user_companies,
          custom_role_permissions, custom_roles, print_templates,
          einvoice_submissions, pos_return_lines, pos_returns,
          pos_tenders, pos_shift_cash_movements, pos_shifts, pos_terminals, user_pos_pins,
          idempotency_keys, notification_user_states, notifications,
          work_order_materials, work_orders, bom_components, bills_of_materials,
          stock_movement_allocations, stock_serials, branch_lot_balances, stock_lots,
          approval_requests, approval_rules,
          gl_account_mappings, currencies, chart_of_accounts, tax_codes,
          journal_lines, journal_entries, fiscal_periods, fiscal_years, exchange_rates, audit_logs,
          credit_note_applications, retainer_applications, retainer_invoices,
          sales_return_lines, sales_returns, received_payment_allocations, received_payments,
          sales_invoice_lines, sales_invoices, sales_order_lines, sales_orders,
          purchase_return_lines, purchase_returns, payment_made_allocations, payments_made,
          vendor_bill_lines, vendor_bills, purchase_receive_lines, purchase_receives,
          purchase_order_lines, purchase_orders,
          stock_transfer_lines, stock_transfers, stock_session_items, stock_sessions,
          stock_write_off_lines, stock_write_offs, stock_adjustment_lines, stock_adjustments,
          stock_movements, branch_products, products, taxonomy_items, customers, vendors,
          document_sequences, company_settings, user_preferences, password_reset_tokens,
          user_branches, user_branch_scopes, user_roles, user_sessions, users, branches, companies
        RESTART IDENTITY CASCADE`)
      );
      const { resetSeededDefaultsCache } = await import("../backend/src/auth/permissions.ts");
      resetSeededDefaultsCache();
    }

    const runTag = Date.now().toString(36).toUpperCase();

    // 1. Seed admin user
    const signupRes = await fetch(`${address}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Load Benchmark Admin",
        email: `load-admin-${runTag}@test.local`,
        password: "Password123!",
      }),
    });
    assert.equal(signupRes.status, 201, "Admin signup must return 201");
    const signupBody = await signupRes.json();
    const adminUserId = signupBody.user.id;
    const rawCookie = signupRes.headers.get("set-cookie") ?? "";
    const sessionCookie = rawCookie.split(";")[0];
    assert.ok(sessionCookie.startsWith("erp_session="), "Session cookie must be issued");

    // Ensure admin role & all branch scope even if running against a non-empty fallback DB
    await db.execute(sql`UPDATE user_roles SET role = 'admin' WHERE user_id = ${adminUserId}`);
    await db.execute(sql`UPDATE user_branch_scopes SET scope_mode = 'all' WHERE user_id = ${adminUserId}`);

    const authHeaders = {
      cookie: sessionCookie,
      "content-type": "application/json",
    };
    const postHeaders = () => ({
      ...authHeaders,
      "idempotency-key": randomUUID(),
    });

    // 2. Fetch HQ branch
    const branchesRes = await fetch(`${address}/api/branches`, { headers: authHeaders });
    assert.equal(branchesRes.status, 200);
    const branchesBody = await branchesRes.json();
    const hqBranchId = branchesBody.branches[0].id;
    assert.ok(hqBranchId, "HQ branch must exist");

    // 3. Seed test product with EXACTLY 5 units in stock (qtyOnHand = 5)
    const prodRes = await fetch(`${address}/api/products`, {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({
        sku: `LOAD-SKU-${runTag}`,
        barcode: `62299${Date.now().toString().slice(-8)}`,
        name: `Contested Load Product ${runTag}`,
        category: "LoadTest",
        brand: "LoadBrand",
        costPrice: 20,
        sellingPrice: 50,
        itemType: "stock",
        initialStock: [{ branchId: hqBranchId, quantity: 5, unitCost: 20 }],
      }),
    });
    assert.equal(prodRes.status, 201, "Product seed must return 201");
    const contestedProductId = (await prodRes.json()).product.id;

    // Seed a customer & sales order for paginated read benchmark
    const custRes = await fetch(`${address}/api/customers`, {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({ name: `Load Customer ${runTag}` }),
    });
    assert.equal(custRes.status, 201);
    const customerId = (await custRes.json()).customer.id;

    const soRes = await fetch(`${address}/api/sales-orders`, {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({
        customerId,
        branchId: hqBranchId,
        status: "Draft",
        lines: [{ productId: contestedProductId, quantity: 1, unitPrice: 50 }],
      }),
    });
    assert.equal(soRes.status, 201);

    // 4. Seed POS terminal and open shift
    const termRes = await fetch(`${address}/api/pos/terminals`, {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({
        branchId: hqBranchId,
        code: `LD-${runTag.slice(-4)}`,
        name: `Load Register ${runTag}`,
        paperWidthMm: 80,
      }),
    });
    assert.equal(termRes.status, 201, "POS terminal seed must return 201");
    const terminalId = (await termRes.json()).terminal.id;

    const shiftRes = await fetch(`${address}/api/pos/shifts/open`, {
      method: "POST",
      headers: postHeaders(),
      body: JSON.stringify({
        terminalId,
        openingFloat: 500,
        notes: "Load benchmark shift",
      }),
    });
    assert.equal(shiftRes.status, 201, "POS shift open must return 201");
    const shiftId = (await shiftRes.json()).shift.id;

    // =========================================================================
    // Benchmark A: Read & Paginated Catalog Throughput
    // =========================================================================
    const endpoints = [
      "/api/health/live",
      `/api/pos/catalog?branchId=${hqBranchId}`,
      "/api/products?page=1&pageSize=25",
      "/api/sales-orders?page=1&pageSize=25",
    ];
    const concurrencyPerEndpoint = 15;
    const allLatencies = [];
    const benchmarkAReport = {};
    let read5xxCount = 0;

    for (const ep of endpoints) {
      const epLatencies = [];
      const tasks = Array.from({ length: concurrencyPerEndpoint }, async () => {
        const t0 = performance.now();
        const res = await fetch(`${address}${ep}`, { headers: authHeaders });
        await res.arrayBuffer();
        const elapsed = performance.now() - t0;
        epLatencies.push(elapsed);
        allLatencies.push(elapsed);
        if (res.status >= 500) read5xxCount += 1;
        assert.equal(res.status, 200, `Expected 200 on ${ep}, got ${res.status}`);
      });
      await Promise.all(tasks);
      benchmarkAReport[ep] = computePercentiles(epLatencies);
    }

    assert.equal(read5xxCount, 0, "Benchmark A must produce 0 HTTP 5xx errors");

    // =========================================================================
    // Benchmark B: 20-Way Concurrent POS Checkout Oversell & GL Integrity Test
    // =========================================================================
    const concurrentCheckouts = 20;
    const checkoutLatencies = [];
    const checkoutResults = await Promise.all(
      Array.from({ length: concurrentCheckouts }, async (_, idx) => {
        const t0 = performance.now();
        const res = await fetch(`${address}/api/pos/checkout`, {
          method: "POST",
          headers: postHeaders(),
          body: JSON.stringify({
            terminalId,
            shiftId,
            notes: `Concurrent checkout #${idx + 1}`,
            lines: [
              {
                productId: contestedProductId,
                description: "Contested Load Product",
                quantity: 1,
                unitPrice: 50,
                discount: 0,
                taxRate: 15,
                isTaxInclusive: false,
              },
            ],
            tenders: [{ method: "cash", amount: 57.5, tenderedAmount: 57.5 }],
          }),
        });
        const body = await res.json().catch(() => ({}));
        checkoutLatencies.push(performance.now() - t0);
        return { status: res.status, body };
      })
    );

    const succeeded201 = checkoutResults.filter((r) => r.status === 201);
    const rejectedInsufficient = checkoutResults.filter(
      (r) =>
        (r.status === 400 || r.status === 409) &&
        (r.body?.code === "INSUFFICIENT_STOCK" ||
          /insufficient stock/i.test(String(r.body?.message ?? "")))
    );
    const checkout5xx = checkoutResults.filter((r) => r.status >= 500);

    assert.equal(
      checkout5xx.length,
      0,
      `Benchmark B must produce 0 HTTP 5xx errors (sample: ${JSON.stringify(checkout5xx[0])})`
    );
    assert.equal(
      succeeded201.length,
      5,
      `Expected exactly 5 checkouts to succeed (201), got ${succeeded201.length} (sample responses: ${JSON.stringify(checkoutResults.slice(0, 3))})`
    );
    assert.equal(
      rejectedInsufficient.length,
      15,
      `Expected exactly 15 checkouts to fail cleanly with INSUFFICIENT_STOCK, got ${rejectedInsufficient.length}`
    );

    // Verify final branch_products.qty_on_hand === 0 (never negative)
    const bpCheck = await db.execute(
      sql`SELECT qty_on_hand FROM branch_products WHERE branch_id = ${hqBranchId} AND product_id = ${contestedProductId}`
    );
    const finalQty = Number(bpCheck[0]?.qty_on_hand ?? -1);
    assert.equal(finalQty, 0, `Final branch_products.qty_on_hand must be 0, got ${finalQty}`);

    // Verify Trial Balance GL integrity
    const tbRes = await fetch(`${address}/api/accounting/reports/trial-balance`, {
      headers: authHeaders,
    });
    assert.equal(tbRes.status, 200, "Trial balance endpoint must return 200");
    const tb = await tbRes.json();
    assert.equal(tb.isBalanced, true, "Trial balance must remain balanced");
    assert.ok(
      Math.abs(Number(tb.totalDebit) - Number(tb.totalCredit)) <= 0.01,
      `Trial balance debit (${tb.totalDebit}) and credit (${tb.totalCredit}) must match within 0.01`
    );

    const summary = {
      benchmarkA: {
        totalRequests: allLatencies.length,
        errors5xx: read5xxCount,
        overallLatencyMs: computePercentiles(allLatencies),
        endpoints: benchmarkAReport,
      },
      benchmarkB: {
        concurrentCheckouts,
        initialStock: 5,
        succeeded201: succeeded201.length,
        rejectedInsufficient4xx: rejectedInsufficient.length,
        errors5xx: checkout5xx.length,
        finalQtyOnHand: finalQty,
        latencyMs: computePercentiles(checkoutLatencies),
        trialBalance: {
          isBalanced: tb.isBalanced,
          totalDebit: tb.totalDebit,
          totalCredit: tb.totalCredit,
        },
      },
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
    await closeDatabase();
    unregisterTsx();
  }
}

main().catch((err) => {
  console.error("Load test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
