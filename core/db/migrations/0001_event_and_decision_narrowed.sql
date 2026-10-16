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