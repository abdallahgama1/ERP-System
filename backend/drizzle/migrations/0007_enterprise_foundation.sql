CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text DEFAULT '' NOT NULL,
	"tax_registration_number" text DEFAULT '' NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"einvoicing_mode" text DEFAULT 'none' NOT NULL,
	"default_branch_id" uuid,
	"address" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "custom_role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"custom_role_id" uuid NOT NULL,
	"module" text NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"can_approve" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_role" "app_role" DEFAULT 'user' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_driver" text DEFAULT 'local' NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"document_type" text NOT NULL,
	"name" text NOT NULL,
	"header_html" text DEFAULT '' NOT NULL,
	"footer_html" text DEFAULT '' NOT NULL,
	"logo_url" text DEFAULT '' NOT NULL,
	"accent_color" text DEFAULT '#0f172a' NOT NULL,
	"custom_css" text DEFAULT '' NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" "app_role" DEFAULT 'user' NOT NULL,
	"custom_role_id" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mfa" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"totp_secret_encrypted" text NOT NULL,
	"recovery_codes_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrolled_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"user_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"name" text NOT NULL,
	"config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_rules" DROP CONSTRAINT "approval_rules_entity_type_unique";--> statement-breakpoint
ALTER TABLE "bills_of_materials" DROP CONSTRAINT "bills_of_materials_bom_number_unique";--> statement-breakpoint
ALTER TABLE "branches" DROP CONSTRAINT "branches_code_unique";--> statement-breakpoint
ALTER TABLE "chart_of_accounts" DROP CONSTRAINT "chart_of_accounts_code_unique";--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_code_unique";--> statement-breakpoint
ALTER TABLE "fiscal_years" DROP CONSTRAINT "fiscal_years_name_unique";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_entry_number_unique";--> statement-breakpoint
ALTER TABLE "payments_made" DROP CONSTRAINT "payments_made_payment_number_unique";--> statement-breakpoint
ALTER TABLE "pos_returns" DROP CONSTRAINT "pos_returns_return_number_unique";--> statement-breakpoint
ALTER TABLE "pos_shifts" DROP CONSTRAINT "pos_shifts_shift_number_unique";--> statement-breakpoint
ALTER TABLE "pos_terminals" DROP CONSTRAINT "pos_terminals_code_unique";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_sku_unique";--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_po_number_unique";--> statement-breakpoint
ALTER TABLE "purchase_receives" DROP CONSTRAINT "purchase_receives_receive_number_unique";--> statement-breakpoint
ALTER TABLE "purchase_returns" DROP CONSTRAINT "purchase_returns_return_number_unique";--> statement-breakpoint
ALTER TABLE "received_payments" DROP CONSTRAINT "received_payments_payment_number_unique";--> statement-breakpoint
ALTER TABLE "retainer_invoices" DROP CONSTRAINT "retainer_invoices_retainer_number_unique";--> statement-breakpoint
ALTER TABLE "sales_invoices" DROP CONSTRAINT "sales_invoices_invoice_number_unique";--> statement-breakpoint
ALTER TABLE "sales_orders" DROP CONSTRAINT "sales_orders_so_number_unique";--> statement-breakpoint
ALTER TABLE "sales_returns" DROP CONSTRAINT "sales_returns_return_number_unique";--> statement-breakpoint
ALTER TABLE "sales_returns" DROP CONSTRAINT "sales_returns_credit_note_number_unique";--> statement-breakpoint
ALTER TABLE "stock_adjustments" DROP CONSTRAINT "stock_adjustments_adjustment_number_unique";--> statement-breakpoint
ALTER TABLE "stock_sessions" DROP CONSTRAINT "stock_sessions_session_number_unique";--> statement-breakpoint
ALTER TABLE "stock_transfers" DROP CONSTRAINT "stock_transfers_transfer_number_unique";--> statement-breakpoint
ALTER TABLE "stock_write_offs" DROP CONSTRAINT "stock_write_offs_write_off_number_unique";--> statement-breakpoint
ALTER TABLE "tax_codes" DROP CONSTRAINT "tax_codes_code_unique";--> statement-breakpoint
ALTER TABLE "vendor_bills" DROP CONSTRAINT "vendor_bills_bill_number_unique";--> statement-breakpoint
ALTER TABLE "vendors" DROP CONSTRAINT "vendors_code_unique";--> statement-breakpoint
ALTER TABLE "work_orders" DROP CONSTRAINT "work_orders_wo_number_unique";--> statement-breakpoint
DROP INDEX "doc_sequences_type_scope_uq";--> statement-breakpoint
DROP INDEX "taxonomy_kind_name_uq";--> statement-breakpoint
ALTER TABLE "currencies" DROP CONSTRAINT IF EXISTS "currencies_pkey";--> statement-breakpoint
ALTER TABLE "gl_account_mappings" DROP CONSTRAINT IF EXISTS "gl_account_mappings_pkey";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "before_json" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "after_json" jsonb;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_lot_balances" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_products" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "currencies" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "gl_account_mappings" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments_made" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_receives" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_payments" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "retainer_invoices" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_sessions" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "taxonomy_items" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_roles" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "active_company_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_company_id_code_pk" PRIMARY KEY("company_id","code");--> statement-breakpoint
ALTER TABLE "gl_account_mappings" ADD CONSTRAINT "gl_account_mappings_company_id_mapping_key_pk" PRIMARY KEY("company_id","mapping_key");--> statement-breakpoint
INSERT INTO "companies" ("id", "code", "name", "legal_name", "tax_registration_number", "base_currency", "einvoicing_mode", "default_branch_id", "address", "phone", "email", "settings_json", "is_default", "is_active")
SELECT '00000000-0000-4000-8000-000000000001'::uuid, 'COMP-01', "company_name", "legal_name", "tax_registration_number", "base_currency", "einvoicing_mode", "default_branch_id", "address", "phone", "email", "settings_json", true, true
FROM "company_settings" WHERE "id" = 1
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "companies" ("id", "code", "name", "is_default", "is_active")
VALUES ('00000000-0000-4000-8000-000000000001'::uuid, 'COMP-01', 'Count It Keep It', true, true)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_companies" ("user_id", "company_id", "role", "is_default", "is_active")
SELECT u."id", '00000000-0000-4000-8000-000000000001'::uuid, COALESCE(ur."role", 'user'::"app_role"), true, true
FROM "users" u
LEFT JOIN "user_roles" ur ON ur."user_id" = u."id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "user_sessions" SET "active_company_id" = '00000000-0000-4000-8000-000000000001'::uuid WHERE "active_company_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "custom_role_permissions" ADD CONSTRAINT "custom_role_permissions_custom_role_id_custom_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_templates" ADD CONSTRAINT "print_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_custom_role_id_custom_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_views" ADD CONSTRAINT "user_saved_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_views" ADD CONSTRAINT "user_saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_active_idx" ON "companies" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_role_permissions_role_module_uq" ON "custom_role_permissions" USING btree ("custom_role_id","module");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_company_name_uq" ON "custom_roles" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "custom_roles_company_idx" ON "custom_roles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "document_attachments_company_entity_idx" ON "document_attachments" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_attachments_storage_key_uq" ON "document_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "print_templates_company_type_name_uq" ON "print_templates" USING btree ("company_id","document_type","name");--> statement-breakpoint
CREATE INDEX "print_templates_company_type_idx" ON "print_templates" USING btree ("company_id","document_type");--> statement-breakpoint
CREATE UNIQUE INDEX "user_companies_user_company_uq" ON "user_companies" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "user_companies_company_idx" ON "user_companies" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_saved_views_user_company_res_name_uq" ON "user_saved_views" USING btree ("user_id","company_id","resource","name");--> statement-breakpoint
CREATE INDEX "user_saved_views_lookup_idx" ON "user_saved_views" USING btree ("company_id","user_id","resource");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_lot_balances" ADD CONSTRAINT "branch_lot_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_account_mappings" ADD CONSTRAINT "gl_account_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments_made" ADD CONSTRAINT "payments_made_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receives" ADD CONSTRAINT "purchase_receives_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "received_payments" ADD CONSTRAINT "received_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_invoices" ADD CONSTRAINT "retainer_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD CONSTRAINT "stock_serials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_sessions" ADD CONSTRAINT "stock_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_write_offs" ADD CONSTRAINT "stock_write_offs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxonomy_items" ADD CONSTRAINT "taxonomy_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_custom_role_id_custom_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_company_status_idx" ON "approval_requests" USING btree ("company_id","status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_rules_company_entity_uq" ON "approval_rules" USING btree ("company_id","entity_type");--> statement-breakpoint
CREATE INDEX "audit_logs_company_created_id_idx" ON "audit_logs" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "boms_company_num_uq" ON "bills_of_materials" USING btree ("company_id","bom_number");--> statement-breakpoint
CREATE INDEX "branch_lot_balances_company_idx" ON "branch_lot_balances" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "branch_products_company_idx" ON "branch_products" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_company_code_uq" ON "branches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "branches_company_idx" ON "branches" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coa_company_code_uq" ON "chart_of_accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "coa_company_type_idx" ON "chart_of_accounts" USING btree ("company_id","account_type");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_code_uq" ON "customers" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "customers_company_name_id_idx" ON "customers" USING btree ("company_id","name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_sequences_company_type_scope_uq" ON "document_sequences" USING btree ("company_id","doc_type","scope_key");--> statement-breakpoint
CREATE INDEX "einvoice_sub_company_status_idx" ON "einvoice_submissions" USING btree ("company_id","status","next_retry_at");--> statement-breakpoint
CREATE INDEX "fx_rates_company_pair_idx" ON "exchange_rates" USING btree ("company_id","from_currency","to_currency","effective_at");--> statement-breakpoint
CREATE INDEX "fiscal_periods_company_dates_idx" ON "fiscal_periods" USING btree ("company_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_company_name_uq" ON "fiscal_years" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_company_num_uq" ON "journal_entries" USING btree ("company_id","entry_number");--> statement-breakpoint
CREATE INDEX "journal_entries_company_date_id_idx" ON "journal_entries" USING btree ("company_id","entry_date","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_company_created_idx" ON "notifications" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_made_company_num_uq" ON "payments_made" USING btree ("company_id","payment_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_returns_company_num_uq" ON "pos_returns" USING btree ("company_id","return_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_company_num_uq" ON "pos_shifts" USING btree ("company_id","shift_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_terminals_company_code_uq" ON "pos_terminals" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_uq" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "products_company_created_id_idx" ON "products" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_company_num_uq" ON "purchase_orders" USING btree ("company_id","po_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receives_company_num_uq" ON "purchase_receives" USING btree ("company_id","receive_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_returns_company_num_uq" ON "purchase_returns" USING btree ("company_id","return_number");--> statement-breakpoint
CREATE UNIQUE INDEX "received_payments_company_num_uq" ON "received_payments" USING btree ("company_id","payment_number");--> statement-breakpoint
CREATE UNIQUE INDEX "retainer_invoices_company_num_uq" ON "retainer_invoices" USING btree ("company_id","retainer_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_company_num_uq" ON "sales_invoices" USING btree ("company_id","invoice_number");--> statement-breakpoint
CREATE INDEX "sales_invoices_company_created_id_idx" ON "sales_invoices" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_company_num_uq" ON "sales_orders" USING btree ("company_id","so_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_returns_company_num_uq" ON "sales_returns" USING btree ("company_id","return_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_returns_company_cn_uq" ON "sales_returns" USING btree ("company_id","credit_note_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_adjustments_company_num_uq" ON "stock_adjustments" USING btree ("company_id","adjustment_number");--> statement-breakpoint
CREATE INDEX "stock_lots_company_expiry_idx" ON "stock_lots" USING btree ("company_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_movements_company_created_id_idx" ON "stock_movements" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "stock_serials_company_serial_idx" ON "stock_serials" USING btree ("company_id","serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_sessions_company_num_uq" ON "stock_sessions" USING btree ("company_id","session_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_company_num_uq" ON "stock_transfers" USING btree ("company_id","transfer_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_write_offs_company_num_uq" ON "stock_write_offs" USING btree ("company_id","write_off_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_codes_company_code_uq" ON "tax_codes" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "taxonomy_company_kind_name_uq" ON "taxonomy_items" USING btree ("company_id","kind","name");--> statement-breakpoint
CREATE INDEX "user_sessions_active_company_idx" ON "user_sessions" USING btree ("active_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_company_num_uq" ON "vendor_bills" USING btree ("company_id","bill_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_code_uq" ON "vendors" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "vendors_company_name_id_idx" ON "vendors" USING btree ("company_id","name","id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_company_num_uq" ON "work_orders" USING btree ("company_id","wo_number");