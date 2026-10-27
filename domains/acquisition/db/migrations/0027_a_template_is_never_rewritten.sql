ALTER TABLE "acquisition"."draft" DROP CONSTRAINT "draft_template_id_template_id_fk";
--> statement-breakpoint
ALTER TABLE "acquisition"."template" ADD COLUMN "corrects" text;--> statement-breakpoint
ALTER TABLE "acquisition"."draft" ADD CONSTRAINT "draft_template_id_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "acquisition"."template"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Decision 0072: a template is never rewritten. What a draft came from, and
-- the plan an enrolment holds against the provider's steps, do not move
-- under them. A correction is a template of its own; one no draft cites may
-- be deleted and recorded again, which the foreign key above allows.
CREATE FUNCTION "acquisition"."template_is_never_rewritten"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'acquisition.template: a template is never rewritten; record a correction instead (decision 0072)'
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "template_is_never_rewritten" BEFORE UPDATE ON "acquisition"."template"
  FOR EACH ROW EXECUTE FUNCTION "acquisition"."template_is_never_rewritten"();
--> statement-breakpoint
-- Decision 0072: a variant is an arm, or a correction of one, and every step
-- of it says the same. A correction names an arm of its experiment, never
-- itself and never another correction: there is no chain to follow. The
-- experiment's row is locked first, so two templates written at once to one
-- experiment are judged one after the other.
CREATE FUNCTION "acquisition"."template_correction_names_an_arm"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "core"."experiment" WHERE id = NEW.experiment_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "acquisition"."template"
    WHERE experiment_id = NEW.experiment_id AND variant = NEW.variant AND corrects IS DISTINCT FROM NEW.corrects
  ) THEN
    RAISE EXCEPTION 'acquisition.template: every step of variant "%" carries the same mark: an arm, or a correction of the same arm (decision 0072)', NEW.variant
      USING ERRCODE = 'check_violation';
  END IF;
  -- A variant naming itself is refused here too: either it has rows, which
  -- carry another mark, or it has none, and is no arm.
  IF NEW.corrects IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "acquisition"."template"
    WHERE experiment_id = NEW.experiment_id AND variant = NEW.corrects AND corrects IS NULL
  ) THEN
    RAISE EXCEPTION 'acquisition.template: a correction names an arm of its experiment, and "%" is none (decision 0072)', NEW.corrects
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "template_correction_names_an_arm" BEFORE INSERT ON "acquisition"."template"
  FOR EACH ROW EXECUTE FUNCTION "acquisition"."template_correction_names_an_arm"();
