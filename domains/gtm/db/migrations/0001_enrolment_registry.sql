CREATE TYPE "gtm"."enrolment_state" AS ENUM('pending', 'enrolled', 'refused');--> statement-breakpoint
CREATE TYPE "gtm"."skip_reason" AS ENUM('protected', 'capacity', 'duplicate', 'unreachable');--> statement-breakpoint
CREATE TABLE "gtm"."enrolment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"company_id" uuid,
	"sequence_key" text NOT NULL,
	"channel" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "gtm"."enrolment_state" DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"refusal" text,
	"enrolled_at" timestamp with time zone,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gtm"."enrolment_skip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence_key" text NOT NULL,
	"channel" text NOT NULL,
	"reason" "gtm"."skip_reason" NOT NULL,
	"detail" text NOT NULL,
	"person" jsonb,
	"company" jsonb NOT NULL,
	"subject" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gtm"."enrolment" ADD CONSTRAINT "enrolment_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."enrolment" ADD CONSTRAINT "enrolment_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."enrolment" ADD CONSTRAINT "enrolment_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."enrolment_skip" ADD CONSTRAINT "enrolment_skip_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrolment_person_sequence_uidx" ON "gtm"."enrolment" USING btree ("person_id","sequence_key");--> statement-breakpoint
CREATE INDEX "enrolment_company_idx" ON "gtm"."enrolment" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "enrolment_pending_idx" ON "gtm"."enrolment" USING btree ("updated_at") WHERE "gtm"."enrolment"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "enrolment_skip_run_subject_uidx" ON "gtm"."enrolment_skip" USING btree ("run_id","subject");--> statement-breakpoint
CREATE INDEX "enrolment_skip_run_reason_idx" ON "gtm"."enrolment_skip" USING btree ("run_id","reason");