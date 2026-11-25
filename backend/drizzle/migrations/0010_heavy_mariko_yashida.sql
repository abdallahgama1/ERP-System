CREATE TABLE "fixed_asset_depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"depreciation_date" timestamp with time zone NOT NULL,
	"depreciation_amount" numeric(18, 4) NOT NULL,
	"accumulated_after" numeric(18, 4) NOT NULL,
	"net_book_value_after" numeric(18, 4) NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"asset_code" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Equipment' NOT NULL,
	"serial_number" text DEFAULT '' NOT NULL,
	"branch_id" uuid,
	"cost_center_id" uuid,
	"acquisition_date" timestamp with time zone NOT NULL,
	"in_service_date" timestamp with time zone NOT NULL,
	"acquisition_cost" numeric(18, 4) NOT NULL,
	"salvage_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" text DEFAULT 'straight_line' NOT NULL,
	"declining_rate_pct" numeric(8, 4) DEFAULT '200' NOT NULL,
	"accumulated_depreciation" numeric(18, 4) DEFAULT '0' NOT NULL,
	"net_book_value" numeric(18, 4) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accum_dep_account_id" uuid NOT NULL,
	"dep_expense_account_id" uuid NOT NULL,
	"acquisition_journal_entry_id" uuid,
	"disposed_at" timestamp with time zone,
	"disposal_proceeds" numeric(18, 4),
	"disposal_journal_entry_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_entries" ADD CONSTRAINT "fixed_asset_depreciation_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accum_dep_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("accum_dep_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_dep_expense_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("dep_expense_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_acquisition_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("acquisition_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_dep_asset_period_uq" ON "fixed_asset_depreciation_entries" USING btree ("asset_id","period_key");--> statement-breakpoint
CREATE INDEX "fixed_asset_dep_company_period_idx" ON "fixed_asset_depreciation_entries" USING btree ("company_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_company_code_uq" ON "fixed_assets" USING btree ("company_id","asset_code");--> statement-breakpoint
CREATE INDEX "fixed_assets_company_status_idx" ON "fixed_assets" USING btree ("company_id","status");--> statement-breakpoint
INSERT INTO "chart_of_accounts" ("company_id", "code", "name", "account_type", "normal_balance", "is_system", "is_active")
SELECT c."id", v."code", v."name", v."account_type", v."normal_balance", true, true
FROM "companies" c
CROSS JOIN (VALUES
  ('1500', 'Fixed Assets — Cost', 'asset', 'debit'),
  ('1510', 'Accumulated Depreciation', 'asset', 'credit'),
  ('5600', 'Realized FX Gain & Loss', 'expense', 'debit'),
  ('5610', 'Unrealized FX Gain & Loss', 'expense', 'debit'),
  ('5700', 'Depreciation Expense', 'expense', 'debit'),
  ('5710', 'Gain & Loss on Asset Disposal', 'expense', 'debit')
) AS v("code", "name", "account_type", "normal_balance")
ON CONFLICT ("company_id", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "gl_account_mappings" ("company_id", "mapping_key", "account_id")
SELECT coa."company_id", m."mapping_key", coa."id"
FROM "chart_of_accounts" coa
INNER JOIN (VALUES
  ('1500', 'fixed_assets_cost'),
  ('1510', 'accumulated_depreciation'),
  ('5600', 'realized_fx'),
  ('5610', 'unrealized_fx'),
  ('5700', 'depreciation_expense'),
  ('5710', 'asset_disposal_gain_loss')
) AS m("code", "mapping_key") ON m."code" = coa."code"
ON CONFLICT ("company_id", "mapping_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "document_sequences" ("company_id", "doc_type", "scope_key", "prefix", "next_number", "padding")
SELECT c."id", 'FA', 'company', 'FA-', 1, 4
FROM "companies" c
ON CONFLICT ("company_id", "doc_type", "scope_key") DO NOTHING;