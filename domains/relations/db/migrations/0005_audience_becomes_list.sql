-- HAND-CORRECTED: this file is not what `drizzle-kit generate` writes.
-- The generator writes only the statements after the DO block below: it
-- drops relations.audience and relations.audience_member, with whatever rows
-- they hold, without a word.
-- The DO block is added by hand so that it stops instead. Regenerating this
-- migration loses it; re-add it, and its test in the domain refuses the
-- migration on a database holding rows until it is back.
--
-- Decision 0037: a set of identified people is a list, frozen when it is
-- constituted; "audience" is kept for an anonymous segment. Nothing in the
-- engine wrote these tables, so they are replaced rather than renamed and
-- converted — an audience was re-evaluated and could exclude, a list is
-- frozen and only selects. On a database where something wrote them anyway,
-- this stops rather than drop what they hold.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "relations"."audience") OR EXISTS (SELECT 1 FROM "relations"."audience_member") THEN
    RAISE EXCEPTION 'relations.audience or relations.audience_member holds rows: they are not dropped silently (decision 0037)'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint
DROP TABLE "relations"."audience" CASCADE;--> statement-breakpoint
DROP TABLE "relations"."audience_member" CASCADE;--> statement-breakpoint
DROP TYPE "relations"."audience_kind";