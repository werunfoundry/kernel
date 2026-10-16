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