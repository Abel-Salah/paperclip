CREATE TABLE "run_secret_redactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"fingerprint_sha256" text NOT NULL,
	"material" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_secret_redactions" ADD CONSTRAINT "run_secret_redactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_secret_redactions" ADD CONSTRAINT "run_secret_redactions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_secret_redactions_company_fingerprint_run_uq" ON "run_secret_redactions" USING btree ("company_id","fingerprint_sha256","run_id");--> statement-breakpoint
CREATE INDEX "run_secret_redactions_company_run_idx" ON "run_secret_redactions" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "run_secret_redactions_sweep_idx" ON "run_secret_redactions" USING btree ("expires_at") WHERE "run_secret_redactions"."material" is not null;