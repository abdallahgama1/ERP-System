import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

function getTestDbUrl(): string {
  if (process.env.TEST_DATABASE_URL?.trim()) return process.env.TEST_DATABASE_URL.trim();
  const envPath = path.resolve(process.cwd(), "backend/.env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*TEST_DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("TEST_DATABASE_URL is required in backend/.env to run Playwright E2E tests");
}

test.describe("POS Offline Outbox & Automatic Reconnect Sync E2E", () => {
  test.beforeAll(async () => {
    const dbUrl = getTestDbUrl();
    const expectedDb = new URL(dbUrl).pathname.replace(/^\//, "");
    const sql = postgres(dbUrl, { connect_timeout: 15, prepare: false });
    const [{ db }] = await sql`SELECT current_database() AS db`;
    if (db !== expectedDb) {
      await sql.end();
      throw new Error(`Refusing to truncate '${db}' instead of '${expectedDb}'`);
    }
    await sql.unsafe(
      "TRUNCATE TABLE einvoice_submissions, pos_tenders, pos_shift_cash_movements, pos_shifts, pos_terminals, user_pos_pins, idempotency_keys, notification_user_states, notifications, work_order_materials, work_orders, bom_components, bills_of_materials, stock_movement_allocations, stock_serials, branch_lot_balances, stock_lots, approval_requests, approval_rules, journal_lines, journal_entries, fiscal_periods, fiscal_years, exchange_rates, audit_logs, credit_note_applications, retainer_applications, retainer_invoices, sales_return_lines, sales_returns, received_payment_allocations, received_payments, sales_invoice_lines, sales_invoices, sales_order_lines, sales_orders, purchase_return_lines, purchase_returns, payment_made_allocations, payments_made, vendor_bill_lines, vendor_bills, purchase_receive_lines, purchase_receives, purchase_order_lines, purchase_orders, stock_transfer_lines, stock_transfers, stock_session_items, stock_sessions, stock_write_off_lines, stock_write_offs, stock_adjustment_lines, stock_adjustments, stock_movements, branch_products, products, taxonomy_items, customers, vendors, user_branches, user_branch_scopes, user_roles, user_sessions, users, branches RESTART IDENTITY CASCADE"
    );
    await sql.end();
  });

  test("completes sale while offline into IndexedDB outbox and syncs cleanly on reconnect", async ({
    page,
    context,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/signup");
    await page.locator("#name").fill("Offline Admin");
    await page.locator("#email").fill("offline-e2e@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("/", { timeout: 20_000 });

    const branchesRes = await page.request.get("/api/branches");
    const hqId = (await branchesRes.json()).branches[0].id as string;

    const prodRes = await page.request.post("/api/products", {
      data: {
        sku: "OFF-01",
        barcode: "6221112223334",
        name: "Offline Coffee Cup",
        costPrice: 10,
        sellingPrice: 50,
        initialStock: [{ branchId: hqId, quantity: 10, unitCost: 10 }],
      },
    });
    expect(prodRes.status()).toBe(201);

    const termRes = await page.request.post("/api/pos/terminals", {
      data: { branchId: hqId, code: "REG-OFF", name: "Offline Counter" },
    });
    expect(termRes.status()).toBe(201);
    const terminalId = (await termRes.json()).terminal.id as string;

    const shiftRes = await page.request.post("/api/pos/shifts/open", {
      data: { terminalId, openingFloat: 100 },
    });
    expect(shiftRes.status()).toBe(201);

    // Load /pos while online so catalog + shift cache to IndexedDB
    await page.goto("/pos");
    await expect(page.getByText("Offline Coffee Cup")).toBeVisible();

    // Go offline!
    await context.setOffline(true);
    await expect(page.getByText(/^Offline$/i)).toBeVisible();

    // Tap product card and complete cash checkout offline
    await page.getByText("Offline Coffee Cup").click();
    await page.getByRole("button", { name: /Charge/i }).click();
    await page.getByRole("button", { name: /Complete Sale/i }).click();

    await expect(page.locator("#pos-thermal-receipt")).toBeVisible();
    await expect(page.locator("#pos-thermal-receipt")).toContainText("OFFLINE-");
    await page.getByRole("button", { name: /New Sale/i }).click();

    // Outbox badge should show 1 pending transaction
    await expect(page.getByRole("button", { name: /Sync \(1\)/i })).toBeVisible();

    // Reconnect -> auto-sync should flush outbox and create real server invoice
    await context.setOffline(false);
    await expect(page.getByText(/^Online$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Sync \(1\)/i })).toBeHidden({ timeout: 15_000 });

    const invRes = await page.request.get("/api/sales-invoices");
    expect(invRes.ok()).toBeTruthy();
    const invJson = await invRes.json();
    expect(invJson.invoices.length).toBeGreaterThanOrEqual(1);
    expect(invJson.invoices[0].invoiceNumber).toMatch(/^POS-/);

    expect(pageErrors).toEqual([]);
  });
});
