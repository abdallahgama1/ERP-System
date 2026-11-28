-- Forward-only migration 0014:
--   1. Make audit_logs.branch_id an immutable UUID snapshot (drop ON DELETE SET NULL FK so removing an unused duplicate branch never breaks the SHA-256 hash chain).
--   2. Upgrade idempotency_keys with company_id (backfilled on existing rows), request_hash, state, locked_until, updated_at, and (company_id, user_id, method, path, key) uniqueness.
--   3. Pre-flight duplicate check across all normalized natural keys: fails safely with a full report instead of silently mutating data.
--   4. Add normalized (lower(btrim(...))) company-scoped unique indexes across natural keys (excluding customer/vendor tax_number which uses a soft 409 warning).

ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_branch_id_branches_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "idempotency_user_req_uq";
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "status_code" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "response_body" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "request_hash" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'completed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
-- Backfill company_id on any existing idempotency_keys rows (e.g. legacy POS sync rows)
UPDATE "idempotency_keys" ik
SET "company_id" = pt."company_id"
FROM "pos_terminals" pt
WHERE ik."pos_terminal_id" IS NOT NULL
  AND pt."id" = ik."pos_terminal_id"
  AND ik."company_id" = '00000000-0000-4000-8000-000000000001';
--> statement-breakpoint
UPDATE "idempotency_keys" ik
SET "company_id" = uc."company_id"
FROM (
  SELECT DISTINCT ON ("user_id") "user_id", "company_id"
  FROM "user_companies"
  WHERE "is_active" = true
  ORDER BY "user_id", "is_default" DESC, "created_at" ASC
) uc
WHERE ik."pos_terminal_id" IS NULL
  AND uc."user_id" = ik."user_id"
  AND ik."company_id" = '00000000-0000-4000-8000-000000000001'
  AND EXISTS (SELECT 1 FROM "companies" c WHERE c."id" = uc."company_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "idempotency_keys"
      ADD CONSTRAINT "idempotency_keys_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_company_user_req_uq"
  ON "idempotency_keys" USING btree ("company_id","user_id","method","path","key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_state_locked_idx"
  ON "idempotency_keys" USING btree ("state","locked_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_invoices_company_source_idx"
  ON "sales_invoices" USING btree ("company_id","source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bills_company_source_idx"
  ON "vendor_bills" USING btree ("company_id","source");
--> statement-breakpoint
-- Pre-flight duplicate check: report ALL duplicate normalized natural keys and abort safely instead of silently altering data.
DO $$
DECLARE
  v_report text := '';
  v_rec record;
  v_checks text[][] := ARRAY[
    ARRAY['branches', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['branches', 'name', 'lower(btrim("name"))', 'btrim("name") <> '''''],
    ARRAY['products', 'sku', 'lower(btrim("sku"))', 'btrim("sku") <> '''''],
    ARRAY['products', 'barcode', 'lower(btrim("barcode"))', '"barcode" IS NOT NULL AND btrim("barcode") <> '''''],
    ARRAY['customers', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['vendors', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['chart_of_accounts', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['cost_centers', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['cost_centers', 'name', 'lower(btrim("name"))', 'btrim("name") <> '''''],
    ARRAY['tax_codes', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['treasury_accounts', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['treasury_accounts', 'name', 'lower(btrim("name"))', 'btrim("name") <> '''''],
    ARRAY['treasury_accounts', 'iban', 'lower(btrim("iban"))', 'btrim("iban") <> '''''],
    ARRAY['fixed_assets', 'asset_code', 'lower(btrim("asset_code"))', 'btrim("asset_code") <> '''''],
    ARRAY['fixed_assets', 'serial_number', 'lower(btrim("serial_number"))', 'btrim("serial_number") <> '''''],
    ARRAY['pos_terminals', 'code', 'lower(btrim("code"))', 'btrim("code") <> '''''],
    ARRAY['pos_terminals', 'name', 'lower(btrim("name"))', 'btrim("name") <> '''''],
    ARRAY['taxonomy_items', 'kind+name', '"kind" || '':'' || lower(btrim("name"))', 'btrim("name") <> '''''],
    ARRAY['custom_roles', 'name', 'lower(btrim("name"))', 'btrim("name") <> ''''']
  ];
  v_idx int;
  v_sql text;
BEGIN
  FOR v_idx IN 1..array_length(v_checks, 1) LOOP
    v_sql := format(
      'SELECT "company_id", (%s) AS norm_val, count(*)::int AS cnt FROM "public".%I WHERE %s GROUP BY 1, 2 HAVING count(*) > 1',
      v_checks[v_idx][3],
      v_checks[v_idx][1],
      v_checks[v_idx][4]
    );
    FOR v_rec IN EXECUTE v_sql LOOP
      v_report := v_report || format(
        E'\n  - %s.%s [company=%s]: "%s" (%s rows)',
        v_checks[v_idx][1],
        v_checks[v_idx][2],
        v_rec.company_id,
        v_rec.norm_val,
        v_rec.cnt
      );
    END LOOP;
  END LOOP;

  IF v_report <> '' THEN
    RAISE EXCEPTION 'Migration 0014 aborted safely: duplicate natural keys detected. Clean them with "npm run ops:deduplicate" before migrating:%', v_report;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_company_code_norm_uq" ON "branches" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_company_name_norm_uq" ON "branches" USING btree ("company_id",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coa_company_code_norm_uq" ON "chart_of_accounts" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_centers_company_code_norm_uq" ON "cost_centers" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_centers_company_name_norm_uq" ON "cost_centers" USING btree ("company_id",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "custom_roles_company_name_norm_uq" ON "custom_roles" USING btree ("company_id",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_company_code_norm_uq" ON "customers" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fixed_assets_company_code_norm_uq" ON "fixed_assets" USING btree ("company_id",lower(btrim("asset_code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fixed_assets_company_serial_norm_uq" ON "fixed_assets" USING btree ("company_id",lower(btrim("serial_number"))) WHERE btrim("fixed_assets"."serial_number") <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_terminals_company_code_norm_uq" ON "pos_terminals" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pos_terminals_company_name_norm_uq" ON "pos_terminals" USING btree ("company_id",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_company_sku_norm_uq" ON "products" USING btree ("company_id",lower(btrim("sku")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_company_barcode_norm_uq" ON "products" USING btree ("company_id",lower(btrim("barcode"))) WHERE "products"."barcode" IS NOT NULL AND btrim("products"."barcode") <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tax_codes_company_code_norm_uq" ON "tax_codes" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "taxonomy_company_kind_name_norm_uq" ON "taxonomy_items" USING btree ("company_id","kind",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_accounts_company_code_norm_uq" ON "treasury_accounts" USING btree ("company_id",lower(btrim("code")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_accounts_company_name_norm_uq" ON "treasury_accounts" USING btree ("company_id",lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "treasury_accounts_company_iban_norm_uq" ON "treasury_accounts" USING btree ("company_id",lower(btrim("iban"))) WHERE btrim("treasury_accounts"."iban") <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_company_code_norm_uq" ON "vendors" USING btree ("company_id",lower(btrim("code")));
