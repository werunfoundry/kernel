-- Decision 0038: a message is appended, never rewritten. What happened to it
-- afterwards is a touch. One change is let through, because the schema itself
-- makes it: deleting a run or an experiment sets the reference to it to null
-- (attribution, doctrine 4), as on `touch` (0026).
CREATE FUNCTION "relations"."message_is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'run_id' - 'experiment_id') = (to_jsonb(OLD) - 'run_id' - 'experiment_id')
     AND (NEW.run_id IS NULL OR NEW.run_id = OLD.run_id)
     AND (NEW.experiment_id IS NULL OR NEW.experiment_id = OLD.experiment_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relations.message is append-only: what was sent is not rewritten (decision 0038)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "message_is_append_only" BEFORE UPDATE ON "relations"."message"
  FOR EACH ROW EXECUTE FUNCTION "relations"."message_is_append_only"();
