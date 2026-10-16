CREATE TYPE "relations"."relationship_status" AS ENUM('customer', 'former_customer', 'none');--> statement-breakpoint
CREATE TABLE "relations"."relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"person_id" uuid,
	"status" "relations"."relationship_status" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_one_subject" CHECK (num_nonnulls("relations"."relationship"."company_id", "relations"."relationship"."person_id") = 1),
	CONSTRAINT "relationship_human_check" CHECK ("relations"."relationship"."actor_type" = 'human')
);
--> statement-breakpoint
-- Decision 0036. Existing touches were written before a touch said whether it
-- was solicited. Outbound ones become unsolicited — the side that counts
-- against a cap, so the backfill fails closed; inbound ones never are. The
-- append-only trigger (0026) is lifted for this one backfill and only here:
-- it refuses any change to a recorded touch, and a column that did not exist
-- is not a rewrite of what happened.
ALTER TABLE "relations"."touch" ADD COLUMN "unsolicited" boolean;--> statement-breakpoint
ALTER TABLE "relations"."touch" DISABLE TRIGGER "touch_is_append_only";--> statement-breakpoint
UPDATE "relations"."touch" SET "unsolicited" = ("direction" = 'outbound');--> statement-breakpoint
ALTER TABLE "relations"."touch" ENABLE TRIGGER "touch_is_append_only";--> statement-breakpoint
ALTER TABLE "relations"."touch" ALTER COLUMN "unsolicited" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "relations"."relationship" ADD CONSTRAINT "relationship_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."relationship" ADD CONSTRAINT "relationship_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."relationship" ADD CONSTRAINT "relationship_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_company_uidx" ON "relations"."relationship" USING btree ("company_id","status","at") WHERE "relations"."relationship"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_person_uidx" ON "relations"."relationship" USING btree ("person_id","status","at") WHERE "relations"."relationship"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "relationship_company_at_idx" ON "relations"."relationship" USING btree ("company_id","at" desc);--> statement-breakpoint
CREATE INDEX "relationship_person_at_idx" ON "relations"."relationship" USING btree ("person_id","at" desc);--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD CONSTRAINT "touch_inbound_not_unsolicited" CHECK ("relations"."touch"."direction" = 'outbound' or not "relations"."touch"."unsolicited");--> statement-breakpoint
CREATE VIEW "relations"."relationship_current" AS (select distinct on (coalesce(company_id, person_id)) company_id, person_id, status, at, reason, actor_id from relations.relationship order by coalesce(company_id, person_id), at desc, created_at desc);