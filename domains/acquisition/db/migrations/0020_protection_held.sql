CREATE TABLE "acquisition"."protection_held" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"protected_as_of" timestamp with time zone NOT NULL,
	"accounts" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acquisition"."protection_held" ADD CONSTRAINT "protection_held_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protection_held_as_of_idx" ON "acquisition"."protection_held" USING btree ("protected_as_of");