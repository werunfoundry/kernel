-- Decision 0027: a draft moves forward only, and what was approved is what
-- goes out. The gate in runtime/draft.ts decides which move to make; this
-- refuses the moves nobody may make, whoever writes the row.
--
--   drafting         -> awaiting_review | approved | dropped
--   awaiting_review  -> approved | dropped
--   approved         -> queued | dropped
--   queued           -> sent | failed
--
-- A draft is created drafting, awaiting review, or approved by its lane. The
-- rendered text may change until the draft is decided, and never after.
CREATE FUNCTION "gtm"."draft_moves_forward"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('drafting', 'awaiting_review', 'approved') THEN
      RAISE EXCEPTION 'gtm.draft: a draft cannot be created %; it is created drafting, awaiting review, or approved (decision 0027)', NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'drafting' AND NEW.state IN ('awaiting_review', 'approved', 'dropped'))
    OR (OLD.state = 'awaiting_review' AND NEW.state IN ('approved', 'dropped'))
    OR (OLD.state = 'approved' AND NEW.state IN ('queued', 'dropped'))
    OR (OLD.state = 'queued' AND NEW.state IN ('sent', 'failed'))
  ) THEN
    RAISE EXCEPTION 'gtm.draft: % to % is not a move a draft makes (decision 0027)', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state NOT IN ('drafting', 'awaiting_review')
     AND (NEW.rendered_subject IS DISTINCT FROM OLD.rendered_subject OR NEW.rendered_body IS DISTINCT FROM OLD.rendered_body) THEN
    RAISE EXCEPTION 'gtm.draft: the text of a % draft is what was decided, and does not change (decision 0027)', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "draft_moves_forward" BEFORE INSERT OR UPDATE ON "gtm"."draft"
  FOR EACH ROW EXECUTE FUNCTION "gtm"."draft_moves_forward"();
