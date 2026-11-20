CREATE TABLE "bills_of_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bom_number" text NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"output_qty" numeric(18, 4) DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_of_materials_bom_number_unique" UNIQUE("bom_number")
);
--> statement-breakpoint
CREATE TABLE "bom_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bom_id" uuid NOT NULL,
	"component_product_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"scrap_percent" numeric(8, 4) DEFAULT '0' NOT NULL,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branch_lot_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"qty_reserved" numeric(18, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"manufacture_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"vendor_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movement_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movement_id" uuid NOT NULL,
	"lot_id" uuid,
	"serial_id" uuid,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"serial_number" text NOT NULL,
	"branch_id" uuid,
	"lot_id" uuid,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"received_from_type" text,
	"received_from_id" text,
	"sold_invoice_id" uuid,
	"work_order_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_order_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"component_product_id" uuid NOT NULL,
	"required_qty" numeric(18, 4) NOT NULL,
	"issued_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_cost_snapshot" numeric(18, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wo_number" text NOT NULL,
	"bom_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"planned_qty" numeric(18, 4) NOT NULL,
	"completed_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'Released' NOT NULL,
	"wip_value_issued" numeric(18, 4) DEFAULT '0' NOT NULL,
	"wip_value_absorbed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_wo_number_unique" UNIQUE("wo_number")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "item_type" text DEFAULT 'stock' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tracking_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "requires_expiry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "shelf_life_days" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "picking_strategy" text DEFAULT 'FEFO' NOT NULL;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills_of_materials" ADD CONSTRAINT "bills_of_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_bom_id_bills_of_materials_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_component_product_id_products_id_fk" FOREIGN KEY ("component_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_lot_balances" ADD CONSTRAINT "branch_lot_balances_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_lot_balances" ADD CONSTRAINT "branch_lot_balances_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_lot_balances" ADD CONSTRAINT "branch_lot_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement_allocations" ADD CONSTRAINT "stock_movement_allocations_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement_allocations" ADD CONSTRAINT "stock_movement_allocations_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement_allocations" ADD CONSTRAINT "stock_movement_allocations_serial_id_stock_serials_id_fk" FOREIGN KEY ("serial_id") REFERENCES "public"."stock_serials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD CONSTRAINT "stock_serials_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD CONSTRAINT "stock_serials_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD CONSTRAINT "stock_serials_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_serials" ADD CONSTRAINT "stock_serials_sold_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("sold_invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_materials" ADD CONSTRAINT "work_order_materials_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_materials" ADD CONSTRAINT "work_order_materials_component_product_id_products_id_fk" FOREIGN KEY ("component_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_bom_id_bills_of_materials_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."bills_of_materials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boms_product_idx" ON "bills_of_materials" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "bom_components_bom_idx" ON "bom_components" USING btree ("bom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_lot_balances_branch_lot_uq" ON "branch_lot_balances" USING btree ("branch_id","lot_id");--> statement-breakpoint
CREATE INDEX "branch_lot_balances_branch_product_idx" ON "branch_lot_balances" USING btree ("branch_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_lots_product_lot_uq" ON "stock_lots" USING btree ("product_id","lot_number");--> statement-breakpoint
CREATE INDEX "stock_lots_expiry_idx" ON "stock_lots" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "stock_mov_alloc_movement_idx" ON "stock_movement_allocations" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "stock_mov_alloc_lot_idx" ON "stock_movement_allocations" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "stock_mov_alloc_serial_idx" ON "stock_movement_allocations" USING btree ("serial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_serials_product_serial_uq" ON "stock_serials" USING btree ("product_id","serial_number");--> statement-breakpoint
CREATE INDEX "stock_serials_branch_status_idx" ON "stock_serials" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "stock_serials_serial_idx" ON "stock_serials" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "wo_materials_wo_idx" ON "work_order_materials" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "work_orders_branch_status_idx" ON "work_orders" USING btree ("branch_id","status");