import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const testDbUrl = (process.env.TEST_DATABASE_URL ?? "").trim().replace(/^['"]|['"]$/g, "");
const describeWithDb = testDbUrl ? describe : describe.skip;

function splitDrizzleSql(rawSql: string): string[] {
  return rawSql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describeWithDb("Pre-0011 to 0012 Forward Migration Upgrade Compatibility", () => {
  it("preserves pre-0011 branches, products, customers, and sales_returns rows with ETA defaults and cleans mismatched COA mappings in 0012", async () => {
    const baseUrl = new URL(testDbUrl);
    const scratchDbName = `erp_mig0011_${crypto.randomBytes(4).toString("hex")}`;
    const adminUrl = new URL(testDbUrl);
    adminUrl.pathname = "/postgres";

    const adminSql = postgres(adminUrl.toString(), { max: 1, connect_timeout: 15 });
    let scratchSql: ReturnType<typeof postgres> | null = null;
    let createdDb = false;

    try {
      await adminSql.unsafe(`CREATE DATABASE "${scratchDbName}"`);
      createdDb = true;

      const scratchUrl = new URL(baseUrl.toString());
      scratchUrl.pathname = `/${scratchDbName}`;
      scratchSql = postgres(scratchUrl.toString(), { max: 1, connect_timeout: 15 });

      const migrationsDir = path.resolve(__dirname, "../../drizzle/migrations");
      const journal = JSON.parse(
        fs.readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")
      ) as { entries: Array<{ idx: number; tag: string }> };

      // 1. Apply migrations 0000 through 0010 (pre-0011 schema)
      for (const entry of journal.entries.filter((e) => e.idx <= 10)) {
        const sqlText = fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
        for (const stmt of splitDrizzleSql(sqlText)) {
          await scratchSql.unsafe(stmt);
        }
      }

      // 2. Seed pre-0011 rows into companies, branches, products, customers, sales_returns,
      //    plus simulate a legacy custom COA account on 3100 wrongly bound to retained_earnings.
      const companyId = "00000000-0000-4000-8000-000000000001";
      await scratchSql`
        INSERT INTO companies (id, code, name, base_currency, is_default, is_active)
        VALUES (${companyId}, 'COMP-01', 'Legacy Pre-0011 Co', 'EGP', true, true)
        ON CONFLICT (id) DO NOTHING
      `;

      const [branch] = await scratchSql<{ id: string }[]>`
        INSERT INTO branches (company_id, code, name, branch_type, is_default, is_active)
        VALUES (${companyId}, 'BR-OLD', 'Legacy Branch', 'retail', true, true)
        RETURNING id
      `;
      const [product] = await scratchSql<{ id: string }[]>`
        INSERT INTO products (company_id, sku, name, cost_price, selling_price)
        VALUES (${companyId}, 'LEGACY-SKU-1', 'Legacy Product', '25.0000', '50.0000')
        RETURNING id
      `;
      const [customer] = await scratchSql<{ id: string }[]>`
        INSERT INTO customers (company_id, code, name)
        VALUES (${companyId}, 'CUST-OLD', 'Legacy Customer')
        RETURNING id
      `;
      const [salesRet] = await scratchSql<{ id: string }[]>`
        INSERT INTO sales_returns (company_id, return_number, credit_note_number, customer_id, branch_id, status, subtotal, tax_total, total_amount)
        VALUES (${companyId}, 'SRTN-OLD', 'CN-OLD', ${customer!.id}, ${branch!.id}, 'Open', '100.0000', '14.0000', '114.0000')
        RETURNING id
      `;

      // Force a mismatched account_type on 3100 bound to retained_earnings to verify migration 0012 cleans it up
      const [badAcct] = await scratchSql<{ id: string }[]>`
        INSERT INTO chart_of_accounts (company_id, code, name, account_type, normal_balance, is_system, is_active)
        VALUES (${companyId}, '3100', 'Legacy Shareholder Loan', 'liability', 'credit', false, true)
        ON CONFLICT (company_id, code) DO UPDATE SET account_type = 'liability', name = 'Legacy Shareholder Loan'
        RETURNING id
      `;
      await scratchSql`
        INSERT INTO gl_account_mappings (company_id, mapping_key, account_id)
        VALUES (${companyId}, 'retained_earnings', ${badAcct!.id})
        ON CONFLICT (company_id, mapping_key) DO UPDATE SET account_id = ${badAcct!.id}
      `;

      // 3. Apply migrations 0011 and 0012
      for (const entry of journal.entries.filter((e) => e.idx >= 11)) {
        const sqlText = fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), "utf8");
        for (const stmt of splitDrizzleSql(sqlText)) {
          await scratchSql.unsafe(stmt);
        }
      }

      // 4. Confirm pre-0011 rows survived intact with expected ETA defaults
      const [branchAfter] = await scratchSql<{
        eta_branch_id: string;
        country: string;
        governorate: string;
      }[]>`SELECT eta_branch_id, country, governorate FROM branches WHERE id = ${branch!.id}`;
      expect(branchAfter).toEqual({ eta_branch_id: "0", country: "EG", governorate: "" });

      const [prodAfter] = await scratchSql<{
        eta_code_type: string;
        eta_item_code: string;
        eta_unit_type: string;
      }[]>`SELECT eta_code_type, eta_item_code, eta_unit_type FROM products WHERE id = ${product!.id}`;
      expect(prodAfter).toEqual({ eta_code_type: "EGS", eta_item_code: "", eta_unit_type: "EA" });

      const [custAfter] = await scratchSql<{ eta_receiver_type: string }[]>`
        SELECT eta_receiver_type FROM customers WHERE id = ${customer!.id}
      `;
      expect(custAfter).toEqual({ eta_receiver_type: "B" });

      const [sretAfter] = await scratchSql<{ e_invoice_status: string }[]>`
        SELECT e_invoice_status FROM sales_returns WHERE id = ${salesRet!.id}
      `;
      expect(sretAfter).toEqual({ e_invoice_status: "not_applicable" });

      // 5. Confirm migration 0012 removed the type-mismatched retained_earnings mapping without touching the 3100 account
      const mappingAfter = await scratchSql`
        SELECT mapping_key FROM gl_account_mappings
        WHERE company_id = ${companyId} AND mapping_key = 'retained_earnings'
      `;
      expect(mappingAfter).toHaveLength(0);
    } finally {
      if (scratchSql) await scratchSql.end({ timeout: 5 }).catch(() => {});
      if (createdDb) {
        await adminSql
          .unsafe(`DROP DATABASE IF EXISTS "${scratchDbName}" WITH (FORCE)`)
          .catch(() => {});
      }
      await adminSql.end({ timeout: 5 }).catch(() => {});
    }
  });
});
