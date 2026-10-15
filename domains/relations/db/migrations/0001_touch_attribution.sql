ALTER TABLE "relations"."touch" ADD COLUMN "actor_type" "core"."actor_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD CONSTRAINT "touch_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;