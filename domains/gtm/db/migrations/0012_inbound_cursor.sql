CREATE TABLE "gtm"."inbound_cursor" (
	"provider" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gtm"."inbound_cursor" ADD CONSTRAINT "inbound_cursor_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;