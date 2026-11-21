CREATE TABLE "einvoice_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"document_type" text DEFAULT 'receipt' NOT NULL,
	"document_uuid" text NOT NULL,
	"submission_uuid" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"request_payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload_json" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_shift_cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"performed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_number" text NOT NULL,
	"terminal_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"closed_by_user_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"opening_float" numeric(18, 4) DEFAULT '0' NOT NULL,
	"expected_cash" numeric(18, 4) DEFAULT '0' NOT NULL,
	"counted_cash" numeric(18, 4),
	"cash_variance" numeric(18, 4),
	"total_cash_sales" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_card_sales" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_wallet_sales" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_sales_count" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "pos_shifts_shift_number_unique" UNIQUE("shift_number")
);
--> statement-breakpoint
CREATE TABLE "pos_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"tendered_amount" numeric(18, 4) NOT NULL,
	"change_given" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"receipt_header" text DEFAULT '' NOT NULL,
	"receipt_footer" text DEFAULT '' NOT NULL,
	"paper_width_mm" integer DEFAULT 80 NOT NULL,
	"default_customer_id" uuid,
	"eta_pos_serial" text DEFAULT '' NOT NULL,
	"eta_pos_os_version" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_terminals_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_pos_pins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_walk_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "pos_terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "source_channel" text DEFAULT 'erp' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "pos_terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "pos_shift_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "cashier_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "offline_client_tx_id" text;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "sync_status" text DEFAULT 'synced' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "eta_document_uuid" text;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "eta_submission_uuid" text;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "eta_receipt_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "pos_terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "active_cashier_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "is_terminal_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_cash_movements" ADD CONSTRAINT "pos_shift_cash_movements_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shift_cash_movements" ADD CONSTRAINT "pos_shift_cash_movements_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_terminal_id_pos_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."pos_terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD CONSTRAINT "pos_shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_tenders" ADD CONSTRAINT "pos_tenders_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_tenders" ADD CONSTRAINT "pos_tenders_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_terminals" ADD CONSTRAINT "pos_terminals_default_customer_id_customers_id_fk" FOREIGN KEY ("default_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pos_pins" ADD CONSTRAINT "user_pos_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "einvoice_sub_status_retry_idx" ON "einvoice_submissions" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_sub_invoice_provider_uq" ON "einvoice_submissions" USING btree ("invoice_id","provider");--> statement-breakpoint
CREATE INDEX "pos_shift_cash_mov_shift_idx" ON "pos_shift_cash_movements" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_shifts_terminal_status_idx" ON "pos_shifts" USING btree ("terminal_id","status");--> statement-breakpoint
CREATE INDEX "pos_shifts_branch_opened_idx" ON "pos_shifts" USING btree ("branch_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_shifts_one_open_per_terminal_uq" ON "pos_shifts" USING btree ("terminal_id") WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "pos_tenders_invoice_idx" ON "pos_tenders" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "pos_tenders_shift_idx" ON "pos_tenders" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_terminals_branch_idx" ON "pos_terminals" USING btree ("branch_id");--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_pos_terminal_id_pos_terminals_id_fk" FOREIGN KEY ("pos_terminal_id") REFERENCES "public"."pos_terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_pos_shift_id_pos_shifts_id_fk" FOREIGN KEY ("pos_shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_pos_terminal_id_pos_terminals_id_fk" FOREIGN KEY ("pos_terminal_id") REFERENCES "public"."pos_terminals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_active_cashier_id_users_id_fk" FOREIGN KEY ("active_cashier_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_pos_terminal_offline_tx_uq" ON "sales_invoices" USING btree ("pos_terminal_id","offline_client_tx_id");