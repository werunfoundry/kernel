CREATE TABLE "relations"."list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"query" jsonb NOT NULL,
	"sealed_at" timestamp with time zone,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."list_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"company_id" uuid,
	"person_id" uuid,
	"reason" text,
	CONSTRAINT "list_member_one_subject" CHECK (num_nonnulls("relations"."list_member"."company_id", "relations"."list_member"."person_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "relations"."list" ADD CONSTRAINT "list_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."list_member" ADD CONSTRAINT "list_member_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "relations"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."list_member" ADD CONSTRAINT "list_member_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."list_member" ADD CONSTRAINT "list_member_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "list_key_uidx" ON "relations"."list" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "list_member_company_uidx" ON "relations"."list_member" USING btree ("list_id","company_id") WHERE "relations"."list_member"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "list_member_person_uidx" ON "relations"."list_member" USING btree ("list_id","person_id") WHERE "relations"."list_member"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "list_member_person_idx" ON "relations"."list_member" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "list_member_company_idx" ON "relations"."list_member" USING btree ("company_id");