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

test.describe("POS Register E2E (Dedicated Workspace, Barcode Checkout, Thermal Receipt & PIN Lock)", () => {
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

  test("runs full POS shift open, barcode checkout, thermal receipt, PIN lock/unlock, and shift close", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // 1. Sign up admin
    await page.goto("/signup");
    await page.locator("#name").fill("POS Manager");
    await page.locator("#email").fill("pos-e2e@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("/", { timeout: 20_000 });

    // Seed branch product + ETA Egypt mode via API using browser session cookie
    const branchesRes = await page.request.get("/api/branches");
    const hqId = (await branchesRes.json()).branches[0].id as string;

    const compRes = await page.request.put("/api/settings/company", {
      data: {
        companyName: "Nile Retail Co",
        legalName: "Nile Retail LLC",
        taxRegistrationNumber: "777888999",
        baseCurrency: "EGP",
        einvoicingMode: "eta_egypt",
      },
    });
    expect(compRes.ok()).toBeTruthy();

    const prodRes = await page.request.post("/api/products", {
      data: {
        sku: "TEA-001",
        barcode: "6229876543210",
        name: "Premium Tea Box",
        costPrice: 30,
        sellingPrice: 100,
        initialStock: [{ branchId: hqId, quantity: 20, unitCost: 30 }],
      },
    });
    expect(prodRes.status()).toBe(201);

    // 2. Navigate to dedicated /pos workspace
    await page.goto("/pos");
    await expect(page.getByText("POS Cashier Register")).toBeVisible();

    // Create first register terminal via UI
    await page.getByRole("button", { name: /Create Register Terminal/i }).click();
    await page.getByRole("button", { name: /^Save$/i }).click();
    await expect(page.getByRole("button", { name: /Open Shift to Start Selling/i })).toBeVisible();

    // 3. Open cashier shift with 250 float
    await page.getByRole("button", { name: /Open Shift to Start Selling/i }).click();
    await page.locator("#pos-opening-float").fill("250");
    await page.getByRole("button", { name: /^Open Shift$/i }).click();
    await expect(page.getByRole("button", { name: /SHF-/i })).toBeVisible();

    // 4. Scan barcode into search box and press Enter -> adds to cart
    const scanInput = page.getByPlaceholder(/Scan barcode or search/i);
    await scanInput.fill("6229876543210");
    await scanInput.press("Enter");
    await expect(page.getByText(/Current Sale \(1\)/i)).toBeVisible();

    // 5. Charge -> pay 200 cash for 100 total -> complete sale -> thermal receipt visible
    await page.getByRole("button", { name: /Charge/i }).click();
    await page.getByRole("button", { name: "200", exact: true }).click();
    await page.getByRole("button", { name: /Complete Sale/i }).click();

    await expect(page.locator("#pos-thermal-receipt")).toBeVisible();
    await expect(page.locator("#pos-thermal-receipt")).toContainText("Nile Retail Co");
    await expect(page.locator("#pos-thermal-receipt")).toContainText("POS-");
    await page.getByRole("button", { name: /New Sale/i }).click();

    // 6. Set cashier PIN (1234), lock terminal, and unlock via keypad
    await page.getByRole("button", { name: /^PIN$/i }).click();
    await page.locator("#pos-new-pin").fill("1234");
    await page.getByRole("button", { name: /^Save$/i }).click();

    await page.getByRole("button", { name: /Lock register/i }).click();
    await expect(page.getByRole("dialog", { name: "POS Terminal PIN Lock" })).toBeVisible();

    for (const d of ["1", "2", "3", "4"]) {
      await page.getByRole("button", { name: d, exact: true }).click();
    }
    await page.getByRole("button", { name: /Unlock/i }).click();
    await expect(page.getByRole("dialog", { name: "POS Terminal PIN Lock" })).toBeHidden();

    // 7. Close shift cleanly (expected cash = 250 + 100 = 350)
    await page.getByRole("button", { name: /SHF-/i }).click();
    await page.locator("#pos-counted-cash").fill("350");
    await page.getByRole("button", { name: /Close Shift & Post Variance/i }).click();
    await expect(page.getByRole("button", { name: /Open Shift to Start Selling/i })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
