CREATE TABLE "gtm"."protection_acknowledgement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" text NOT NULL,
	"note" text NOT NULL,
	"actor_type" "core"."actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"withdrawn_run_id" uuid,
	CONSTRAINT "protection_acknowledgement_human_check" CHECK ("gtm"."protection_acknowledgement"."actor_type" = 'human'),
	CONSTRAINT "protection_acknowledgement_withdrawal_check" CHECK (("gtm"."protection_acknowledgement"."withdrawn_at" is null) = ("gtm"."protection_acknowledgement"."withdrawn_by" is null) and ("gtm"."protection_acknowledgement"."withdrawn_at" is null) = ("gtm"."protection_acknowledgement"."withdrawn_run_id" is null))
);
--> statement-breakpoint
ALTER TABLE "gtm"."protection_acknowledgement" ADD CONSTRAINT "protection_acknowledgement_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gtm"."protection_acknowledgement" ADD CONSTRAINT "protection_acknowledgement_withdrawn_run_id_run_id_fk" FOREIGN KEY ("withdrawn_run_id") REFERENCES "core"."run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "protection_acknowledgement_standing_uidx" ON "gtm"."protection_acknowledgement" USING btree ("customer_id") WHERE "gtm"."protection_acknowledgement"."withdrawn_at" is null;