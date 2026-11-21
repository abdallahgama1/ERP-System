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

test.describe("Pagination & Lazy Bundle Enforcement E2E", () => {
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

  test("never eagerly loads xlsx/jspdf/zxing on Dashboard or POS and renders paginated views cleanly", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const requestedUrls: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("request", (req) => requestedUrls.push(req.url()));

    await page.goto("/signup");
    await page.locator("#name").fill("Scale Admin");
    await page.locator("#email").fill("scale-e2e@test.local");
    await page.locator("#password").fill("Password123!");
    await page.locator("#confirmPassword").fill("Password123!");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("/", { timeout: 20_000 });

    // Heavy export & scanner libraries must NOT be eagerly requested on Dashboard or POS
    const heavyHits = requestedUrls.filter((u) => /xlsx|jspdf|html2canvas|zxing/i.test(u));
    expect(heavyHits).toEqual([]);

    // Navigate paginated pages cleanly
    await page.goto("/audit-log");
    await expect(page.getByRole("heading", { name: /Audit Log/i, level: 1 })).toBeVisible();

    await page.goto("/reports/movement-history");
    await expect(page.getByRole("heading", { name: /Movement History/i, level: 1 })).toBeVisible();

    await page.goto("/accounting/journal-entries");
    await expect(page.getByRole("heading", { name: /Journal Entries/i, level: 1 })).toBeVisible();

    await page.goto("/sales/invoices");
    await expect(page.getByRole("heading", { name: /Invoices/i, level: 1 })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
