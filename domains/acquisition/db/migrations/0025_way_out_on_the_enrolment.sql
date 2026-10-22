CREATE TYPE "acquisition"."way_out" AS ENUM('written', 'cut', 'absent');--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "way_out" "acquisition"."way_out";--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "way_out_line" text;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "way_out_link" text;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "way_out_read_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD COLUMN "way_out_why" text;--> statement-breakpoint
ALTER TABLE "acquisition"."enrolment" ADD CONSTRAINT "enrolment_way_out_recorded" CHECK (("acquisition"."enrolment"."way_out" is null and "acquisition"."enrolment"."way_out_line" is null and "acquisition"."enrolment"."way_out_link" is null and "acquisition"."enrolment"."way_out_read_back_at" is null and "acquisition"."enrolment"."way_out_why" is null)
       or ("acquisition"."enrolment"."way_out" is not null and "acquisition"."enrolment"."way_out" = 'written' and "acquisition"."enrolment"."state"::text in ('enrolled', 'suspended') and "acquisition"."enrolment"."way_out_line" is not null and "acquisition"."enrolment"."way_out_link" is not null and "acquisition"."enrolment"."way_out_read_back_at" is not null and "acquisition"."enrolment"."way_out_why" is null)
       or ("acquisition"."enrolment"."way_out" is not null and "acquisition"."enrolment"."way_out" in ('cut', 'absent') and "acquisition"."enrolment"."state"::text in ('enrolled', 'suspended') and "acquisition"."enrolment"."way_out_line" is null and "acquisition"."enrolment"."way_out_link" is null and "acquisition"."enrolment"."way_out_read_back_at" is null and "acquisition"."enrolment"."way_out_why" is not null));--> statement-breakpoint
-- Decision 0067: the way out's record is written once, when the enrolment is
-- made, and never rewritten — the rewrite section 1 rules out. Erasure alone
-- replaces the line and the link, which name the person's record at the
-- provider, by a fixed text, in the update that empties `person_id` (0053);
-- the state, the time and the reason stand.
CREATE FUNCTION "acquisition"."enrolment_way_out_is_written_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  erasing boolean;
BEGIN
  erasing := OLD.person_id IS NOT NULL AND NEW.person_id IS NULL;
  IF OLD.way_out IS NOT NULL AND (
       NEW.way_out IS DISTINCT FROM OLD.way_out
    OR NEW.way_out_read_back_at IS DISTINCT FROM OLD.way_out_read_back_at
    OR NEW.way_out_why IS DISTINCT FROM OLD.way_out_why
    OR (NEW.way_out_line IS DISTINCT FROM OLD.way_out_line AND NOT (erasing AND NEW.way_out_line = 'erased (decision 0053)'))
    OR (NEW.way_out_link IS DISTINCT FROM OLD.way_out_link AND NOT (erasing AND NEW.way_out_link = 'erased (decision 0053)'))
  ) THEN
    RAISE EXCEPTION 'acquisition.enrolment: the way out is recorded once and never rewritten (decision 0067)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "enrolment_way_out_is_written_once" BEFORE UPDATE ON "acquisition"."enrolment"
  FOR EACH ROW EXECUTE FUNCTION "acquisition"."enrolment_way_out_is_written_once"();
