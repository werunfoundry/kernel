-- Decision 0039: an event and a decision are appended, never rewritten.
--
-- No reference on either is set null by the schema — every one restricts —
-- so there is no exception to make: every column must come out as it went in.
-- Whether an event was handled is a run that names it, not an update; a
-- decision that turned out wrong is followed by another, never edited.
CREATE FUNCTION "core"."is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: what was observed or concluded is not rewritten (decision 0039)', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "event_is_append_only" BEFORE UPDATE ON "core"."event"
  FOR EACH ROW EXECUTE FUNCTION "core"."is_append_only"();--> statement-breakpoint
CREATE TRIGGER "decision_is_append_only" BEFORE UPDATE ON "core"."decision"
  FOR EACH ROW EXECUTE FUNCTION "core"."is_append_only"();
