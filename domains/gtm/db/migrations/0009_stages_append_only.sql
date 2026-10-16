-- Decision 0036: a declared stage is appended, never rewritten. A mistaken one
-- is corrected by another declaration, which says why. No reference here is
-- set null by the schema, so every column must come out as it went in.
CREATE FUNCTION "gtm"."state_is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: a declaration is corrected by another, never rewritten (decision 0036)', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "person_state_is_append_only" BEFORE UPDATE ON "gtm"."person_state"
  FOR EACH ROW EXECUTE FUNCTION "gtm"."state_is_append_only"();--> statement-breakpoint
CREATE TRIGGER "company_state_is_append_only" BEFORE UPDATE ON "gtm"."company_state"
  FOR EACH ROW EXECUTE FUNCTION "gtm"."state_is_append_only"();
