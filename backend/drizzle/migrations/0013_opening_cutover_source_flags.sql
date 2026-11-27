-- Forward-only migration: add source flags to opening cutover artifacts so opening AR, AP,
-- Fixed Assets, and Treasury records can be cleanly excluded from operational VAT/Sales/ETA
-- pipelines and cleanly undone via controlled opening-balances reversal.

ALTER TABLE "sales_invoices"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_invoices_company_source_idx"
  ON "sales_invoices" USING btree ("company_id", "source");
--> statement-breakpoint

ALTER TABLE "vendor_bills"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_bills_company_source_idx"
  ON "vendor_bills" USING btree ("company_id", "source");
--> statement-breakpoint

ALTER TABLE "fixed_assets"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint

ALTER TABLE "treasury_accounts"
  ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'standard' NOT NULL;
