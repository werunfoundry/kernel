-- Decision 0046: the domain called gtm is acquisition. Hand-written: drizzle
-- cannot express a schema rename without asking, and would otherwise drop and
-- recreate every table. Not additive, and reversible by renaming back.
--
-- The schema moves whole — tables, views, enums, functions, triggers — and
-- the rows in it stay where they are. Table and value names do not change.
ALTER SCHEMA "gtm" RENAME TO "acquisition";--> statement-breakpoint
-- The one function whose text names the schema, in its refusals: recreated,
-- body unchanged but for that name, so a refused move says acquisition.draft.
CREATE OR REPLACE FUNCTION "acquisition"."draft_moves_forward"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('drafting', 'awaiting_review', 'approved') THEN
      RAISE EXCEPTION 'acquisition.draft: a draft cannot be created %; it is created drafting, awaiting review, or approved (decision 0027)', NEW.state
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
    RAISE EXCEPTION 'acquisition.draft: % to % is not a move a draft makes (decision 0027)', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state NOT IN ('drafting', 'awaiting_review')
     AND (NEW.rendered_subject IS DISTINCT FROM OLD.rendered_subject OR NEW.rendered_body IS DISTINCT FROM OLD.rendered_body) THEN
    RAISE EXCEPTION 'acquisition.draft: the text of a % draft is what was decided, and does not change (decision 0027)', OLD.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
