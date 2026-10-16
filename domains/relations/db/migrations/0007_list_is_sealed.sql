-- Decision 0037: a list is frozen once it is constituted.
--
-- A list is written unsealed, its members inserted, and the list sealed — all
-- in one transaction (`constituteList`). After the seal, nothing about the
-- list moves: not the list, not a member, and no new member. The one change
-- let through is a member's deletion, so that erasing a person is never
-- blocked by a list they were once on.
CREATE FUNCTION "relations"."list_is_sealed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL
     AND (to_jsonb(NEW) - 'sealed_at') = (to_jsonb(OLD) - 'sealed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relations.list is frozen: a list is sealed once, and then never changed (decision 0037)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "list_is_sealed" BEFORE UPDATE ON "relations"."list"
  FOR EACH ROW EXECUTE FUNCTION "relations"."list_is_sealed"();--> statement-breakpoint
CREATE FUNCTION "relations"."list_member_is_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "relations"."list" WHERE "id" = NEW.list_id AND "sealed_at" IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relations.list_member is frozen: a sealed list gains no member, and a member is never rewritten (decision 0037)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "list_member_is_frozen" BEFORE INSERT OR UPDATE ON "relations"."list_member"
  FOR EACH ROW EXECUTE FUNCTION "relations"."list_member_is_frozen"();
