CREATE TABLE "gtm"."company_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"stage" "gtm"."lifecycle_stage" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_state_human_check" CHECK ("gtm"."company_state"."actor_type" = 'human')
);
--> statement-breakpoint
CREATE TABLE "gtm"."person_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"stage" "gtm"."lifecycle_stage" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_state_human_check" CHECK ("gtm"."person_state"."actor_type" = 'human')
);
--> statement-breakpoint
ALTER TABLE "gtm"."company_state" ADD CONSTRAINT "company_state_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."company_state" ADD CONSTRAINT "company_state_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."person_state" ADD CONSTRAINT "person_state_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."person_state" ADD CONSTRAINT "person_state_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_state_declared_uidx" ON "gtm"."company_state" USING btree ("company_id","stage","at");--> statement-breakpoint
CREATE INDEX "company_state_company_at_idx" ON "gtm"."company_state" USING btree ("company_id","at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "person_state_declared_uidx" ON "gtm"."person_state" USING btree ("person_id","stage","at");--> statement-breakpoint
CREATE INDEX "person_state_person_at_idx" ON "gtm"."person_state" USING btree ("person_id","at" desc);--> statement-breakpoint
CREATE VIEW "gtm"."company_state_current" AS (select distinct on (company_id) company_id, stage, at, reason, actor_id from gtm.company_state order by company_id, at desc, created_at desc);--> statement-breakpoint
CREATE VIEW "gtm"."person_state_current" AS (select distinct on (person_id) person_id, stage, at, reason, actor_id from gtm.person_state order by person_id, at desc, created_at desc);