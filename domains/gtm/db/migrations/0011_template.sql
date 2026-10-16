CREATE TABLE "gtm"."template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"step" integer NOT NULL,
	"channel" text NOT NULL,
	"angle" text,
	"persona" text,
	"subject" text,
	"body" text NOT NULL,
	"truths_cited" text[],
	"delay_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "gtm"."template" ADD CONSTRAINT "template_experiment_id_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "core"."experiment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_experiment_variant_step_uidx" ON "gtm"."template" USING btree ("experiment_id","variant","step");--> statement-breakpoint
ALTER TABLE "gtm"."draft" ADD CONSTRAINT "draft_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "gtm"."template"("id") ON DELETE set null ON UPDATE no action;