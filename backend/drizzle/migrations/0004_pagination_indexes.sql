CREATE INDEX "audit_logs_created_id_idx" ON "audit_logs" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_created_id_idx" ON "audit_logs" USING btree ("entity_type","created_at","id");--> statement-breakpoint
CREATE INDEX "audit_logs_branch_created_id_idx" ON "audit_logs" USING btree ("branch_id","created_at","id");--> statement-breakpoint
CREATE INDEX "journal_entries_date_created_id_idx" ON "journal_entries" USING btree ("entry_date","created_at","id");--> statement-breakpoint
CREATE INDEX "journal_entries_branch_date_created_id_idx" ON "journal_entries" USING btree ("branch_id","entry_date","created_at","id");--> statement-breakpoint
CREATE INDEX "sales_invoices_branch_created_id_idx" ON "sales_invoices" USING btree ("branch_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sales_invoices_status_date_id_idx" ON "sales_invoices" USING btree ("status","invoice_date","id");--> statement-breakpoint
CREATE INDEX "sales_invoices_created_id_idx" ON "sales_invoices" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "stock_movements_created_id_idx" ON "stock_movements" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "stock_movements_branch_created_id_idx" ON "stock_movements" USING btree ("branch_id","created_at","id");