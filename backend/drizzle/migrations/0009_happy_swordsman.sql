CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"statement_id" uuid NOT NULL,
	"treasury_account_id" uuid NOT NULL,
	"line_date" timestamp with time zone NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"running_balance" numeric(18, 4),
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"matched_journal_line_id" uuid,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"treasury_account_id" uuid NOT NULL,
	"statement_number" text NOT NULL,
	"file_name" text DEFAULT 'statement.csv' NOT NULL,
	"from_date" timestamp with time zone,
	"to_date" timestamp with time zone,
	"line_count" integer DEFAULT 0 NOT NULL,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"branch_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"cost_center_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"net_amount" numeric(18, 4) NOT NULL,
	"tax_code_id" uuid,
	"tax_rate" numeric(8, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(18, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"claim_number" text NOT NULL,
	"claim_date" timestamp with time zone DEFAULT now() NOT NULL,
	"branch_id" uuid,
	"submitted_by" uuid,
	"submitted_by_name" text DEFAULT '' NOT NULL,
	"payee_name" text DEFAULT '' NOT NULL,
	"payment_mode" text DEFAULT 'direct_treasury' NOT NULL,
	"treasury_account_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text DEFAULT '' NOT NULL,
	"accrual_journal_entry_id" uuid,
	"payment_journal_entry_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"branch_id" uuid,
	"gl_account_id" uuid NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"account_number" text DEFAULT '' NOT NULL,
	"iban" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"transfer_number" text NOT NULL,
	"transfer_date" timestamp with time zone DEFAULT now() NOT NULL,
	"from_treasury_account_id" uuid NOT NULL,
	"to_treasury_account_id" uuid NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"memo" text DEFAULT '' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_treasury_account_id_treasury_accounts_id_fk" FOREIGN KEY ("treasury_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("matched_journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_treasury_account_id_treasury_accounts_id_fk" FOREIGN KEY ("treasury_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_expense_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_treasury_account_id_treasury_accounts_id_fk" FOREIGN KEY ("treasury_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_accrual_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("accrual_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_payment_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_accounts" ADD CONSTRAINT "treasury_accounts_gl_account_id_chart_of_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_from_treasury_account_id_treasury_accounts_id_fk" FOREIGN KEY ("from_treasury_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_to_treasury_account_id_treasury_accounts_id_fk" FOREIGN KEY ("to_treasury_account_id") REFERENCES "public"."treasury_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_stmt_lines_treasury_fp_uq" ON "bank_statement_lines" USING btree ("treasury_account_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_stmt_lines_matched_jl_uq" ON "bank_statement_lines" USING btree ("matched_journal_line_id") WHERE "bank_statement_lines"."matched_journal_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bank_stmt_lines_treasury_status_idx" ON "bank_statement_lines" USING btree ("treasury_account_id","status","line_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_company_num_uq" ON "bank_statements" USING btree ("company_id","statement_number");--> statement-breakpoint
CREATE INDEX "bank_statements_treasury_idx" ON "bank_statements" USING btree ("treasury_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_centers_company_code_uq" ON "cost_centers" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "cost_centers_company_active_idx" ON "cost_centers" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "expense_claim_lines_claim_idx" ON "expense_claim_lines" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "expense_claim_lines_cc_idx" ON "expense_claim_lines" USING btree ("cost_center_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claims_company_num_uq" ON "expense_claims" USING btree ("company_id","claim_number");--> statement-breakpoint
CREATE INDEX "expense_claims_company_status_date_idx" ON "expense_claims" USING btree ("company_id","status","claim_date");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_accounts_company_code_uq" ON "treasury_accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_accounts_company_gl_uq" ON "treasury_accounts" USING btree ("company_id","gl_account_id");--> statement-breakpoint
CREATE INDEX "treasury_accounts_company_type_idx" ON "treasury_accounts" USING btree ("company_id","account_type");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_transfers_company_num_uq" ON "treasury_transfers" USING btree ("company_id","transfer_number");--> statement-breakpoint
CREATE INDEX "treasury_transfers_company_date_idx" ON "treasury_transfers" USING btree ("company_id","transfer_date");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_cost_center_idx" ON "journal_lines" USING btree ("cost_center_id");--> statement-breakpoint
INSERT INTO "role_permissions" ("role", "module", "can_view", "can_create", "can_edit", "can_delete", "can_approve") VALUES
  ('admin', 'treasury', true, true, true, true, true),
  ('admin', 'expenses', true, true, true, true, true),
  ('admin', 'fixed_assets', true, true, true, true, true),
  ('manager', 'treasury', true, true, true, false, true),
  ('manager', 'expenses', true, true, true, false, true),
  ('manager', 'fixed_assets', true, true, true, false, true),
  ('user', 'treasury', false, false, false, false, false),
  ('user', 'expenses', true, true, false, false, false),
  ('user', 'fixed_assets', false, false, false, false, false)
ON CONFLICT ("role", "module") DO NOTHING;--> statement-breakpoint
INSERT INTO "custom_role_permissions" ("custom_role_id", "module", "can_view", "can_create", "can_edit", "can_delete", "can_approve")
SELECT cr."id", m."module",
  CASE
    WHEN cr."name" IN ('Admin', 'Finance Manager') THEN true
    WHEN cr."name" = 'Accountant' THEN true
    WHEN cr."name" = 'Branch Manager' THEN true
    ELSE false
  END AS can_view,
  CASE
    WHEN cr."name" IN ('Admin', 'Finance Manager') THEN true
    WHEN cr."name" = 'Accountant' THEN true
    WHEN cr."name" = 'Branch Manager' AND m."module" = 'expenses' THEN true
    ELSE false
  END AS can_create,
  CASE
    WHEN cr."name" IN ('Admin', 'Finance Manager') THEN true
    WHEN cr."name" = 'Accountant' THEN true
    WHEN cr."name" = 'Branch Manager' AND m."module" = 'expenses' THEN true
    ELSE false
  END AS can_edit,
  CASE
    WHEN cr."name" IN ('Admin', 'Finance Manager') THEN true
    ELSE false
  END AS can_delete,
  CASE
    WHEN cr."name" IN ('Admin', 'Finance Manager') THEN true
    WHEN cr."name" = 'Branch Manager' AND m."module" = 'expenses' THEN true
    ELSE false
  END AS can_approve
FROM "custom_roles" cr
CROSS JOIN (VALUES ('treasury'), ('expenses'), ('fixed_assets')) AS m("module")
ON CONFLICT ("custom_role_id", "module") DO NOTHING;--> statement-breakpoint
INSERT INTO "chart_of_accounts" ("company_id", "code", "name", "account_type", "normal_balance", "is_system", "is_active")
SELECT c."id", v."code", v."name", v."account_type", v."normal_balance", true, true
FROM "companies" c
CROSS JOIN (VALUES
  ('2400', 'Employee Expense Reimbursements Payable', 'liability', 'credit'),
  ('3100', 'Retained Earnings', 'equity', 'credit'),
  ('5500', 'General Operating Expenses', 'expense', 'debit')
) AS v("code", "name", "account_type", "normal_balance")
ON CONFLICT ("company_id", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "gl_account_mappings" ("company_id", "mapping_key", "account_id")
SELECT coa."company_id", m."mapping_key", coa."id"
FROM "chart_of_accounts" coa
INNER JOIN (VALUES
  ('2400', 'employee_reimbursements'),
  ('3100', 'retained_earnings'),
  ('5500', 'operating_expenses')
) AS m("code", "mapping_key") ON m."code" = coa."code"
ON CONFLICT ("company_id", "mapping_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "document_sequences" ("company_id", "doc_type", "scope_key", "prefix", "next_number", "padding")
SELECT c."id", s."doc_type", 'company', s."prefix", 1, 4
FROM "companies" c
CROSS JOIN (VALUES
  ('TRFT', 'TRFT-'),
  ('BST', 'BST-'),
  ('EXP', 'EXP-')
) AS s("doc_type", "prefix")
ON CONFLICT ("company_id", "doc_type", "scope_key") DO NOTHING;