import { sql } from "drizzle-orm";
import { ensureSeededDefaults, resetSeededDefaultsCache } from "../../src/auth/permissions.ts";
import type { AppDatabase } from "../../src/db/index.ts";

export const CANONICAL_TRUNCATE_SQL = `TRUNCATE TABLE
  document_attachments, user_saved_views, user_mfa, user_companies,
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
RESTART IDENTITY CASCADE`;

export async function assertTestDatabaseName(db: AppDatabase, testDbUrl: string): Promise<void> {
  const expectedDb = new URL(testDbUrl).pathname.replace(/^\//, "");
  const check = await db.execute(sql`SELECT current_database() AS db`);
  const activeDb = (check[0] as { db?: string } | undefined)?.db;
  if (activeDb !== expectedDb) {
    throw new Error(
      `Refusing to run destructive integration tests against '${activeDb}' instead of '${expectedDb}'`
    );
  }
}

export async function resetTestDatabase(
  db: AppDatabase,
  opts: { reseed?: boolean } = {}
): Promise<void> {
  await db.execute(sql.raw(CANONICAL_TRUNCATE_SQL));
  resetSeededDefaultsCache();
  if (opts.reseed !== false) {
    await ensureSeededDefaults(db);
  }
}
