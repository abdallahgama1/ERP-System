CREATE TABLE "auth_lockouts" (
	"scope" text NOT NULL,
	"identifier" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_lockouts_scope_identifier_pk" PRIMARY KEY("scope","identifier")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "chain_seq" bigint;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "entry_hash" text;--> statement-breakpoint
ALTER TABLE "user_mfa" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_lockouts_locked_until_idx" ON "auth_lockouts" USING btree ("locked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_company_chain_seq_uq" ON "audit_logs" USING btree ("company_id","chain_seq");