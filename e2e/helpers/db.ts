import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

export function getTestDbUrl(): string {
  if (process.env.TEST_DATABASE_URL?.trim()) {
    return process.env.TEST_DATABASE_URL.trim().replace(/^['"]|['"]$/g, "");
  }
  const envPath = path.resolve(process.cwd(), "backend/.env");
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*TEST_DATABASE_URL\s*=\s*(.+)\s*$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  throw new Error("TEST_DATABASE_URL is required in backend/.env to run Playwright E2E tests");
}

/**
 * Truncates all 85 schema tables (pre-0007 + Wave 1 0007 tables + company-scoped reference tables)
 * cleanly with RESTART IDENTITY CASCADE. `resetTestDatabase()` immediately re-inserts the baseline
 * COMP-01 row (`default_branch_id = NULL`) so `ensureSeededDefaults()` re-seeds HQ-01, 8 presets,
 * CoA/GL/tax/currency defaults, and document sequences deterministically with zero COMP-02+ leakage.
 */
export const CANONICAL_TRUNCATE_SQL = `TRUNCATE TABLE
  einvoice_submissions, pos_return_lines, pos_returns,
  pos_tenders, pos_shift_cash_movements, pos_shifts, pos_terminals, user_pos_pins,
  idempotency_keys, notification_user_states, notifications,
  user_saved_views, document_attachments, print_templates,
  work_order_materials, work_orders, bom_components, bills_of_materials,
  stock_movement_allocations, stock_serials, branch_lot_balances, stock_lots,
  approval_requests, approval_rules,
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
  chart_of_accounts, gl_account_mappings, currencies, tax_codes,
  document_sequences, company_settings, user_preferences, password_reset_tokens,
  user_mfa, user_companies, custom_role_permissions, custom_roles,
  user_branches, user_branch_scopes, user_roles, user_sessions, users, branches,
  role_permissions, companies
RESTART IDENTITY CASCADE`;

export async function withTestDb<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const dbUrl = getTestDbUrl();
  const expectedDb = new URL(dbUrl).pathname.replace(/^\//, "");
  const sql = postgres(dbUrl, { connect_timeout: 15, prepare: false });
  try {
    const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (db !== expectedDb) {
      throw new Error(`Refusing to access '${db}' instead of '${expectedDb}'`);
    }
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

export async function resetTestDatabase(): Promise<void> {
  await withTestDb(async (sql) => {
    await sql.unsafe(CANONICAL_TRUNCATE_SQL);
    await sql`
      INSERT INTO companies (id, code, name, base_currency, einvoicing_mode, is_default, is_active)
      VALUES ('00000000-0000-4000-8000-000000000001'::uuid, 'COMP-01', 'Count It Keep It', 'USD', 'none', true, true)
      ON CONFLICT (id) DO NOTHING
    `;
  });
}
