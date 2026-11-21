CREATE TABLE "pos_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pos_return_id" uuid NOT NULL,
	"original_invoice_line_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(8, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(18, 4) NOT NULL,
	"restocked_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_cost_snapshot" numeric(18, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_number" text NOT NULL,
	"original_invoice_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"refund_method" text NOT NULL,
	"restock_items" boolean DEFAULT true NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"eta_document_uuid" text,
	"eta_submission_uuid" text,
	"eta_receipt_status" text DEFAULT 'not_applicable' NOT NULL,
	"e_invoice_payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_returns_return_number_unique" UNIQUE("return_number")
);
--> statement-breakpoint
DROP INDEX "einvoice_sub_invoice_provider_uq";--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD COLUMN "pos_return_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "total_cash_refunds" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "total_card_refunds" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "total_wallet_refunds" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_shifts" ADD COLUMN "total_refunds_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_pos_return_id_pos_returns_id_fk" FOREIGN KEY ("pos_return_id") REFERENCES "public"."pos_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_original_invoice_line_id_sales_invoice_lines_id_fk" FOREIGN KEY ("original_invoice_line_id") REFERENCES "public"."sales_invoice_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_original_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("original_invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_terminal_id_pos_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."pos_terminals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_shift_id_pos_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."pos_shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_return_lines_ret_idx" ON "pos_return_lines" USING btree ("pos_return_id");--> statement-breakpoint
CREATE INDEX "pos_return_lines_orig_line_idx" ON "pos_return_lines" USING btree ("original_invoice_line_id");--> statement-breakpoint
CREATE INDEX "pos_returns_original_inv_idx" ON "pos_returns" USING btree ("original_invoice_id");--> statement-breakpoint
CREATE INDEX "pos_returns_shift_idx" ON "pos_returns" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_returns_branch_created_id_idx" ON "pos_returns" USING btree ("branch_id","created_at","id");--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_pos_return_id_pos_returns_id_fk" FOREIGN KEY ("pos_return_id") REFERENCES "public"."pos_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_name_id_idx" ON "customers" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "customers_created_id_idx" ON "customers" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_sub_pos_return_provider_uq" ON "einvoice_submissions" USING btree ("pos_return_id","provider") WHERE "einvoice_submissions"."pos_return_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "password_reset_expires_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "products_name_id_idx" ON "products" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "products_created_id_idx" ON "products" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_branch_created_id_idx" ON "purchase_orders" USING btree ("branch_id","created_at","id");--> statement-breakpoint
CREATE INDEX "purchase_orders_created_id_idx" ON "purchase_orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "sales_invoices_pos_shift_date_id_idx" ON "sales_invoices" USING btree ("pos_shift_id","invoice_date","id");--> statement-breakpoint
CREATE INDEX "sales_orders_branch_created_id_idx" ON "sales_orders" USING btree ("branch_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sales_orders_created_id_idx" ON "sales_orders" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "vendor_bills_branch_created_id_idx" ON "vendor_bills" USING btree ("branch_id","created_at","id");--> statement-breakpoint
CREATE INDEX "vendor_bills_created_id_idx" ON "vendor_bills" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "vendors_name_id_idx" ON "vendors" USING btree ("name","id");--> statement-breakpoint
CREATE INDEX "vendors_created_id_idx" ON "vendors" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_sub_invoice_provider_uq" ON "einvoice_submissions" USING btree ("invoice_id","provider") WHERE "einvoice_submissions"."invoice_id" IS NOT NULL;