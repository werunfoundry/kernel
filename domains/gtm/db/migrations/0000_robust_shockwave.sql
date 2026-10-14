CREATE SCHEMA "gtm";
--> statement-breakpoint
CREATE TYPE "gtm"."draft_state" AS ENUM('drafting', 'awaiting_review', 'approved', 'dropped', 'queued', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "gtm"."lifecycle_stage" AS ENUM('unknown', 'targeted', 'engaged', 'opportunity', 'customer', 'lost');--> statement-breakpoint
CREATE TABLE "gtm"."company_state" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"lifecycle_stage" "gtm"."lifecycle_stage" DEFAULT 'unknown' NOT NULL,
	"stage_changed_at" timestamp with time zone,
	"last_touched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtm"."draft" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"message_id" uuid,
	"step" integer NOT NULL,
	"state" "gtm"."draft_state" DEFAULT 'drafting' NOT NULL,
	"rendered_subject" text,
	"rendered_body" text,
	"sender" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"drop_reason" text,
	"edited_before_approval" boolean DEFAULT false NOT NULL,
	"actor_type" "core"."actor_type" DEFAULT 'agent' NOT NULL,
	"actor_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtm"."message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"step" integer NOT NULL,
	"channel" text NOT NULL,
	"angle" text,
	"persona" text,
	"subject" text,
	"body" text NOT NULL,
	"truths_cited" text[],
	"delay_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtm"."person_state" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"lifecycle_stage" "gtm"."lifecycle_stage" DEFAULT 'unknown' NOT NULL,
	"stage_changed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gtm"."company_state" ADD CONSTRAINT "company_state_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD CONSTRAINT "draft_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD CONSTRAINT "draft_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD CONSTRAINT "draft_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "gtm"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD CONSTRAINT "draft_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."message" ADD CONSTRAINT "message_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."person_state" ADD CONSTRAINT "person_state_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_state_stage_idx" ON "gtm"."company_state" USING btree ("lifecycle_stage");--> statement-breakpoint
CREATE INDEX "company_state_last_touched_idx" ON "gtm"."company_state" USING btree ("last_touched_at" desc nulls last);--> statement-breakpoint
CREATE UNIQUE INDEX "draft_experiment_person_step_uidx" ON "gtm"."draft" USING btree ("experiment_id","person_id","step");--> statement-breakpoint
CREATE INDEX "draft_state_created_at_idx" ON "gtm"."draft" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_experiment_variant_step_uidx" ON "gtm"."message" USING btree ("experiment_id","variant","step");--> statement-breakpoint
CREATE INDEX "person_state_stage_idx" ON "gtm"."person_state" USING btree ("lifecycle_stage");