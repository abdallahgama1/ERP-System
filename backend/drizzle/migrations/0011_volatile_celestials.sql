ALTER TABLE "branches" ADD COLUMN "eta_branch_id" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "country" text DEFAULT 'EG' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "governorate" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "region_city" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "street" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "building_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "postal_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "eta_receiver_type" text DEFAULT 'B' NOT NULL;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD COLUMN "sales_return_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "eta_code_type" text DEFAULT 'EGS' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "eta_item_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "eta_unit_type" text DEFAULT 'EA' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD COLUMN "eta_document_uuid" text;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD COLUMN "eta_submission_uuid" text;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD COLUMN "e_invoice_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD COLUMN "e_invoice_payload_json" jsonb;--> statement-breakpoint
ALTER TABLE "einvoice_submissions" ADD CONSTRAINT "einvoice_submissions_sales_return_id_sales_returns_id_fk" FOREIGN KEY ("sales_return_id") REFERENCES "public"."sales_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_sub_sales_return_provider_uq" ON "einvoice_submissions" USING btree ("sales_return_id","provider") WHERE "einvoice_submissions"."sales_return_id" IS NOT NULL;