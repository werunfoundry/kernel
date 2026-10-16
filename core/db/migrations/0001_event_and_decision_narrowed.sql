-- HAND-CORRECTED: this file is not what `drizzle-kit generate` writes.
-- The generator writes only the statements after the DO block below: it
-- drops the columns of core.event and core.decision, with whatever rows hold
-- them, without a word.
-- The DO block is added by hand so that it stops instead. Regenerating this
-- migration loses it; re-add it, and its test in the domain refuses the
-- migration on a database holding rows until it is back.
--
-- Decision 0039: an event is appended, never marked handled in place, and a
-- decision is one line a person writes about an experiment. Nothing in the
-- engine wrote either table, so their columns are replaced rather than
-- converted. On a database where something wrote them anyway, this stops
-- rather than drop what they hold.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "core"."event") OR EXISTS (SELECT 1 FROM "core"."decision") THEN
    RAISE EXCEPTION 'core.event or core.decision holds rows: they are not dropped silently (decision 0039)'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint
DROP INDEX "core"."decision_subject_idx";--> statement-breakpoint
DROP INDEX "core"."event_unprocessed_idx";--> statement-breakpoint
ALTER TABLE "core"."decision" DROP COLUMN "subject_kind";--> statement-breakpoint
ALTER TABLE "core"."decision" DROP COLUMN "subject_id";--> statement-breakpoint
ALTER TABLE "core"."decision" DROP COLUMN "choice";--> statement-breakpoint
ALTER TABLE "core"."decision" DROP COLUMN "metric_snapshot";--> statement-breakpoint
ALTER TABLE "core"."event" DROP COLUMN "processed_at";