ALTER TYPE "acquisition"."enrolment_state" ADD VALUE 'suspended';--> statement-breakpoint
ALTER TYPE "acquisition"."skip_reason" ADD VALUE 'suspended';--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_run_id" uuid;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_read_back" jsonb;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_method" text;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "suspension_costs" jsonb;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD CONSTRAINT "enrolment_suspension_run_id_run_id_fk" FOREIGN KEY ("suspension_run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD CONSTRAINT "enrolment_suspension_recorded" CHECK (("acquisition"."enrolment"."state"::text = 'suspended' and "acquisition"."enrolment"."suspension_asked_at" is not null and "acquisition"."enrolment"."suspension_read_back" is not null and "acquisition"."enrolment"."suspension_method" is not null and "acquisition"."enrolment"."suspension_costs" is not null)
       or ("acquisition"."enrolment"."state"::text <> 'suspended' and "acquisition"."enrolment"."suspension_asked_at" is null and "acquisition"."enrolment"."suspension_run_id" is null and "acquisition"."enrolment"."suspension_read_back" is null and "acquisition"."enrolment"."suspension_method" is null and "acquisition"."enrolment"."suspension_costs" is null));--> statement-breakpoint
-- Decision 0051: `suspended` is reached from `enrolled` only, and is terminal.
-- The code that will suspend decides when; this refuses the moves nobody may
-- make, whoever writes the row.
--
--   enrolled  -> suspended
--   suspended -> (nothing: the state and its record do not change)
--
-- States are compared as text: `suspended` is added above, and a value added
-- to an enum cannot be used in the transaction that adds it. A plpgsql body
-- is parsed when it runs, not here; the casts keep it safe either way.
--
-- `suspension_run_id` may still become null on a suspended row: it is
-- attribution, and losing the run keeps the suspension (doctrine 4). The
-- company and the last writer's run may too, for the same reason.
--
-- What this does not reach: DELETE. Erasure deletes a person's enrolment
-- rows (`domain.yaml`), suspended ones included, so a person suspended and
-- then erased leaves no row, and a later run can enrol them in the same
-- sequence again. No guard refuses the delete: it would make erasure fail.
-- Erasure that suspends before it deletes is decision 0051's to build.
CREATE FUNCTION "acquisition"."enrolment_suspension_is_terminal"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state::text = 'suspended' THEN
      RAISE EXCEPTION 'acquisition.enrolment: an enrolment cannot be created suspended; it is suspended from enrolled (decision 0051)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state::text = 'suspended' AND (
       NEW.state::text <> 'suspended'
    OR NEW.suspension_asked_at IS DISTINCT FROM OLD.suspension_asked_at
    OR NEW.suspension_read_back IS DISTINCT FROM OLD.suspension_read_back
    OR NEW.suspension_method IS DISTINCT FROM OLD.suspension_method
    OR NEW.suspension_costs IS DISTINCT FROM OLD.suspension_costs
    OR (NEW.suspension_run_id IS DISTINCT FROM OLD.suspension_run_id AND NEW.suspension_run_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'acquisition.enrolment: a suspended enrolment is terminal; its state and its record do not change (decision 0051)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state::text = 'suspended' AND OLD.state::text <> 'suspended' AND OLD.state::text <> 'enrolled' THEN
    RAISE EXCEPTION 'acquisition.enrolment: % to suspended is not a move an enrolment makes; only an enrolled one is suspended (decision 0051)', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "enrolment_suspension_is_terminal" BEFORE INSERT OR UPDATE ON "acquisition"."enrolment"
  FOR EACH ROW EXECUTE FUNCTION "acquisition"."enrolment_suspension_is_terminal"();
