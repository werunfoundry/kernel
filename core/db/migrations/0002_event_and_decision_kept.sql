ALTER TABLE "core"."decision" DROP CONSTRAINT "decision_run_id_run_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."decision" ALTER COLUMN "actor_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."decision" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."decision" ADD COLUMN "experiment_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."decision" ADD COLUMN "conclusion" text NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."decision" ADD COLUMN "readings" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."event" ADD COLUMN "occurred_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."event" ADD COLUMN "run_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."decision" ADD CONSTRAINT "decision_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."decision" ADD CONSTRAINT "decision_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event" ADD CONSTRAINT "event_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_experiment_idx" ON "core"."decision" USING btree ("experiment_id","decided_at");--> statement-breakpoint
CREATE INDEX "event_kind_occurred_at_idx" ON "core"."event" USING btree ("kind","occurred_at");--> statement-breakpoint
ALTER TABLE "core"."decision" ADD CONSTRAINT "decision_human_check" CHECK ("core"."decision"."actor_type" = 'human');--> statement-breakpoint
ALTER TABLE "core"."decision" ADD CONSTRAINT "decision_readings_check" CHECK (jsonb_typeof("core"."decision"."readings") = 'array');