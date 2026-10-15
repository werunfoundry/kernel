-- Decision 0026: a touch is appended, never rewritten.
--
-- One change is let through, because the schema itself makes it: deleting a
-- run or an experiment sets the touch's reference to it to null (attribution,
-- doctrine 4). Every other column must come out as it went in. The comparison
-- is over the whole row as JSON less those two references, so a column added
-- later is covered without editing this function.
CREATE FUNCTION "relations"."touch_is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'run_id' - 'experiment_id') = (to_jsonb(OLD) - 'run_id' - 'experiment_id')
     AND (NEW.run_id IS NULL OR NEW.run_id = OLD.run_id)
     AND (NEW.experiment_id IS NULL OR NEW.experiment_id = OLD.experiment_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relations.touch is append-only: a recorded touch is not rewritten (decision 0026)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "touch_is_append_only" BEFORE UPDATE ON "relations"."touch"
  FOR EACH ROW EXECUTE FUNCTION "relations"."touch_is_append_only"();
