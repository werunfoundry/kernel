ALTER TABLE "acquisition"."enrolment" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
-- Decision 0053: erasure anonymises an enrolment instead of deleting it. A
-- suspended row's record stays frozen (0051) but for one change: in the
-- update that empties `person_id`, the provider's read-back, which may name
-- the person, is replaced by the fixed document `acquisition`'s erasure rule
-- writes. The same document, spelled the same way, is in its `domain.yaml`.
CREATE OR REPLACE FUNCTION "acquisition"."enrolment_suspension_is_terminal"() RETURNS trigger
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
    OR (NEW.suspension_read_back IS DISTINCT FROM OLD.suspension_read_back AND NOT (
          OLD.person_id IS NOT NULL AND NEW.person_id IS NULL
          AND NEW.suspension_read_back = '{"erased": "decision 0053"}'::jsonb))
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
$$;
