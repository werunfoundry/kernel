-- HAND-CORRECTED: this file is not what `drizzle-kit generate` writes.
-- The generator writes only the statements after the DO block below: it
-- drops gtm.person_state and gtm.company_state, with whatever rows they hold,
-- without a word.
-- The DO block is added by hand so that it stops instead. Regenerating this
-- migration loses it; re-add it, and its test in the domain refuses the
-- migration on a database holding rows until it is back.
--
-- Decision 0036: a stage is a declaration kept as a history, and being a
-- customer leaves this domain. The two state tables were one row per subject
-- and nothing in the engine wrote them, so they are replaced rather than
-- converted. On a database where something wrote them anyway, this stops
-- rather than drop what it holds: those rows need a person to say where each
-- one goes — a stage here, or a relationship in `relations`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "gtm"."person_state") OR EXISTS (SELECT 1 FROM "gtm"."company_state") THEN
    RAISE EXCEPTION 'gtm.person_state or gtm.company_state holds rows: they are not dropped silently (decision 0036)'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint
DROP TABLE "gtm"."company_state" CASCADE;--> statement-breakpoint
DROP TABLE "gtm"."person_state" CASCADE;--> statement-breakpoint
DROP TYPE "gtm"."lifecycle_stage";--> statement-breakpoint
CREATE TYPE "gtm"."lifecycle_stage" AS ENUM('targeted', 'engaged', 'opportunity');