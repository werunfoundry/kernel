-- Decision 0036: a declared relationship is appended, never rewritten. A
-- mistaken one is corrected by another declaration, which says why.
--
-- Every column must come out as it went in. Unlike a touch, no reference here
-- is set null by the schema — the run is restrict, the subject cascades — so
-- there is no exception to make.
CREATE FUNCTION "relations"."relationship_is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'relations.relationship is append-only: a declaration is corrected by another, never rewritten (decision 0036)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "relationship_is_append_only" BEFORE UPDATE ON "relations"."relationship"
  FOR EACH ROW EXECUTE FUNCTION "relations"."relationship_is_append_only"();
