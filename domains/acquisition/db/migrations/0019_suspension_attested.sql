CREATE TABLE "acquisition"."suspension_refusal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suspension_refusal_reason" CHECK ("acquisition"."suspension_refusal"."reason" in ('unbound', 'other_provider', 'cannot_suspend', 'unanswered'))
);
--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" DROP CONSTRAINT "enrolment_suspension_recorded";--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_attestation" jsonb;--> statement-breakpoint
ALTER TABLE "acquisition"."suspension_refusal" ADD CONSTRAINT "suspension_refusal_enrolment_id_enrolment_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "acquisition"."enrolment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition"."suspension_refusal" ADD CONSTRAINT "suspension_refusal_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suspension_refusal_enrolment_idx" ON "acquisition"."suspension_refusal" USING btree ("enrolment_id");--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD CONSTRAINT "enrolment_suspension_recorded" CHECK (("acquisition"."enrolment"."state"::text = 'suspended' and "acquisition"."enrolment"."suspension_asked_at" is not null and (
             ("acquisition"."enrolment"."suspension_read_back" is not null and "acquisition"."enrolment"."suspension_method" is not null and "acquisition"."enrolment"."suspension_costs" is not null and "acquisition"."enrolment"."suspension_attestation" is null)
          or ("acquisition"."enrolment"."suspension_attestation" is not null and "acquisition"."enrolment"."suspension_read_back" is null and "acquisition"."enrolment"."suspension_method" is null and "acquisition"."enrolment"."suspension_costs" is null)))
       or ("acquisition"."enrolment"."state"::text <> 'suspended' and "acquisition"."enrolment"."suspension_asked_at" is null and "acquisition"."enrolment"."suspension_run_id" is null and "acquisition"."enrolment"."suspension_read_back" is null and "acquisition"."enrolment"."suspension_method" is null and "acquisition"."enrolment"."suspension_costs" is null and "acquisition"."enrolment"."suspension_attestation" is null));--> statement-breakpoint
-- Decisions 0056 and 0060: a suspended row's record is frozen (0051) whether it is a
-- read-back or an attestation, and erasure replaces either by the same fixed
-- document, in the update that empties `person_id` (0053), which
-- `enrolment_names_its_person` allows only as the person is erased.
CREATE OR REPLACE FUNCTION "acquisition"."enrolment_suspension_is_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  erasing boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state::text = 'suspended' THEN
      RAISE EXCEPTION 'acquisition.enrolment: an enrolment cannot be created suspended; it is suspended from enrolled (decision 0051)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  erasing := OLD.person_id IS NOT NULL AND NEW.person_id IS NULL;
  IF OLD.state::text = 'suspended' AND (
       NEW.state::text <> 'suspended'
    OR NEW.suspension_asked_at IS DISTINCT FROM OLD.suspension_asked_at
    OR (NEW.suspension_read_back IS DISTINCT FROM OLD.suspension_read_back AND NOT (
          erasing AND NEW.suspension_read_back = '{"erased": "decision 0053"}'::jsonb))
    OR (NEW.suspension_attestation IS DISTINCT FROM OLD.suspension_attestation AND NOT (
          erasing AND NEW.suspension_attestation = '{"erased": "decision 0053"}'::jsonb))
    OR NEW.suspension_method IS DISTINCT FROM OLD.suspension_method
    OR NEW.suspension_costs IS DISTINCT FROM OLD.suspension_costs
    OR (NEW.suspension_run_id IS DISTINCT FROM OLD.suspension_run_id AND NEW.suspension_run_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'acquisition.enrolment: a suspended enrolment is terminal; its state and its record do not change (decision 0051)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Decision 0060: a pending row is stopped as it stands under a person's
  -- attestation, and only so. A read-back that confirms it goes through
  -- `enrolled`; a person's word never writes `enrolled`.
  IF NEW.state::text = 'suspended' AND OLD.state::text = 'pending'
     AND NOT (NEW.suspension_attestation IS NOT NULL AND NEW.suspension_read_back IS NULL) THEN
    RAISE EXCEPTION 'acquisition.enrolment: a pending enrolment is suspended as it stands only under a person''s attestation; one a read-back confirms is enrolled first (decision 0060)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state::text = 'suspended' AND OLD.state::text NOT IN ('suspended', 'enrolled', 'pending') THEN
    RAISE EXCEPTION 'acquisition.enrolment: % to suspended is not a move an enrolment makes; only an enrolled one, or a pending one under attestation, is suspended (decisions 0051, 0060)', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
