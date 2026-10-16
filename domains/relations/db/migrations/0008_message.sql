CREATE TABLE "relations"."message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"person_id" uuid NOT NULL,
	"experiment_id" uuid,
	"channel" text NOT NULL,
	"sender" text,
	"subject" text,
	"body" text NOT NULL,
	"unsolicited" boolean NOT NULL,
	"approved_by" text,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text,
	"run_id" uuid,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_approved_check" CHECK ("relations"."message"."actor_type" = 'human' or "relations"."message"."approved_by" is not null)
);
--> statement-breakpoint
ALTER TABLE "relations"."message" ADD CONSTRAINT "message_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "relations"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."message" ADD CONSTRAINT "message_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations"."message" ADD CONSTRAINT "message_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_key_uidx" ON "relations"."message" USING btree ("key");--> statement-breakpoint
CREATE INDEX "message_person_unsolicited_idx" ON "relations"."message" USING btree ("person_id","written_at" desc) WHERE "relations"."message"."unsolicited";