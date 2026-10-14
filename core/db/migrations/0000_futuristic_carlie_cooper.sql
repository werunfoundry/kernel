CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TYPE "core"."actor_type" AS ENUM('human', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "core"."experiment_status" AS ENUM('draft', 'running', 'measuring', 'validated', 'killed');--> statement-breakpoint
CREATE TYPE "core"."lane" AS ENUM('reviewed', 'autonomous', 'reactive');--> statement-breakpoint
CREATE TYPE "core"."run_status" AS ENUM('running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "core"."trigger_kind" AS ENUM('webhook', 'cron', 'cli', 'manual');--> statement-breakpoint
CREATE TABLE "core"."decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid,
	"choice" text NOT NULL,
	"rationale" text,
	"metric_snapshot" jsonb,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text,
	"run_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."experiment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"status" "core"."experiment_status" DEFAULT 'draft' NOT NULL,
	"hypothesis_ref" text NOT NULL,
	"owner" text,
	"lane" "core"."lane" DEFAULT 'reviewed' NOT NULL,
	"autonomy_streak" integer DEFAULT 0 NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metric" text,
	"kill_threshold" numeric,
	"minimum_sample" integer,
	"budget_eur" numeric,
	"run_starts_at" timestamp with time zone,
	"run_ends_at" timestamp with time zone,
	"measure_starts_at" timestamp with time zone,
	"measure_ends_at" timestamp with time zone,
	"baseline_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"process_key" text NOT NULL,
	"trigger" "core"."trigger_kind" NOT NULL,
	"status" "core"."run_status" DEFAULT 'running' NOT NULL,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text,
	"event_id" uuid,
	"dry_run" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "core"."decision" ADD CONSTRAINT "decision_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."run" ADD CONSTRAINT "run_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_subject_idx" ON "core"."decision" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_provider_event_uidx" ON "core"."event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "event_unprocessed_idx" ON "core"."event" USING btree ("received_at") WHERE "core"."event"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_slug_uidx" ON "core"."experiment" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "experiment_measure_ends_at_idx" ON "core"."experiment" USING btree ("measure_ends_at");--> statement-breakpoint
CREATE INDEX "run_process_started_at_idx" ON "core"."run" USING btree ("process_key","started_at" desc);