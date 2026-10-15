CREATE TYPE "gtm"."sourcing_outcome" AS ENUM('kept', 'protected', 'known_to_crm', 'opted_out', 'duplicate', 'incomplete', 'unreachable', 'not_reached', 'simulated');--> statement-breakpoint
CREATE TABLE "gtm"."sourcing_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"pass" text NOT NULL,
	"outcome" "gtm"."sourcing_outcome" NOT NULL,
	"detail" text NOT NULL,
	"person" jsonb,
	"company" jsonb NOT NULL,
	"person_id" uuid,
	"said" jsonb,
	"cost" jsonb,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sourcing_result_pass_check" CHECK ("gtm"."sourcing_result"."pass" in ('company', 'person')),
	CONSTRAINT "sourcing_result_company_pass_check" CHECK ("gtm"."sourcing_result"."pass" = 'person' or "gtm"."sourcing_result"."person" is null)
);
--> statement-breakpoint
ALTER TABLE "gtm"."sourcing_result" ADD CONSTRAINT "sourcing_result_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."sourcing_result" ADD CONSTRAINT "sourcing_result_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_result_run_subject_uidx" ON "gtm"."sourcing_result" USING btree ("run_id","subject");--> statement-breakpoint
CREATE INDEX "sourcing_result_run_outcome_idx" ON "gtm"."sourcing_result" USING btree ("run_id","outcome");