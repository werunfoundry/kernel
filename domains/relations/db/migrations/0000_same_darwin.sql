CREATE SCHEMA "relations";
--> statement-breakpoint
CREATE TYPE "relations"."audience_kind" AS ENUM('include', 'exclude');--> statement-breakpoint
CREATE TYPE "relations"."direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "relations"."email_status" AS ENUM('unknown', 'valid', 'risky', 'catch_all', 'invalid');--> statement-breakpoint
CREATE TABLE "relations"."audience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" "relations"."audience_kind" NOT NULL,
	"description" text,
	"definition" jsonb,
	"refreshed_at" timestamp with time zone,
	"max_staleness_minutes" integer DEFAULT 1440 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."audience_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audience_id" uuid NOT NULL,
	"company_id" uuid,
	"person_id" uuid,
	"source" text NOT NULL,
	"rule" text,
	"reason" text,
	"as_of" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" uuid,
	CONSTRAINT "audience_member_one_target" CHECK (num_nonnulls("relations"."audience_member"."company_id", "relations"."audience_member"."person_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "relations"."company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"domain" text,
	"name" text NOT NULL,
	"record_id" text,
	"research_data" jsonb,
	"research_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text,
	"email" text,
	"full_name" text,
	"title" text,
	"company_id" uuid,
	"record_id" text,
	"email_status" "relations"."email_status" DEFAULT 'unknown' NOT NULL,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations"."signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"person_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_one_target" CHECK (num_nonnulls("relations"."signal"."company_id", "relations"."signal"."person_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "relations"."touch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"experiment_id" uuid,
	"channel" text NOT NULL,
	"direction" "relations"."direction" NOT NULL,
	"sender" text,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"outcome" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relations"."audience_member" ADD CONSTRAINT "audience_member_audience_id_audience_id_fk" FOREIGN KEY ("audience_id") REFERENCES "relations"."audience"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."audience_member" ADD CONSTRAINT "audience_member_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."audience_member" ADD CONSTRAINT "audience_member_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."audience_member" ADD CONSTRAINT "audience_member_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."person" ADD CONSTRAINT "person_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."signal" ADD CONSTRAINT "signal_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "relations"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."signal" ADD CONSTRAINT "signal_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD CONSTRAINT "touch_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD CONSTRAINT "touch_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audience_key_uidx" ON "relations"."audience" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "audience_member_company_uidx" ON "relations"."audience_member" USING btree ("audience_id","company_id") WHERE "relations"."audience_member"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "audience_member_person_uidx" ON "relations"."audience_member" USING btree ("audience_id","person_id") WHERE "relations"."audience_member"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "audience_member_company_lookup_idx" ON "relations"."audience_member" USING btree ("company_id","audience_id");--> statement-breakpoint
CREATE INDEX "audience_member_person_lookup_idx" ON "relations"."audience_member" USING btree ("person_id","audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_external_id_uidx" ON "relations"."company" USING btree ("external_id") WHERE "relations"."company"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "company_domain_lower_uidx" ON "relations"."company" USING btree (lower("domain")) WHERE "relations"."company"."domain" is not null;--> statement-breakpoint
CREATE INDEX "company_research_fetched_at_idx" ON "relations"."company" USING btree ("research_fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "person_external_id_uidx" ON "relations"."person" USING btree ("external_id") WHERE "relations"."person"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "person_email_lower_uidx" ON "relations"."person" USING btree (lower("email")) WHERE "relations"."person"."email" is not null;--> statement-breakpoint
CREATE INDEX "person_company_id_idx" ON "relations"."person" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_content_hash_uidx" ON "relations"."signal" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "signal_expires_at_idx" ON "relations"."signal" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "touch_provider_event_uidx" ON "relations"."touch" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "touch_person_occurred_at_idx" ON "relations"."touch" USING btree ("person_id","occurred_at" desc);--> statement-breakpoint
CREATE INDEX "touch_sender_occurred_at_idx" ON "relations"."touch" USING btree ("sender","occurred_at" desc);