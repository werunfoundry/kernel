-- Decision 0050: a failed draft says why. Nothing wrote 'failed' before this
-- (0027 left it to a sending path that did not exist); on a database where
-- something did, the check refuses to be added rather than invent a reason.
ALTER TABLE "acquisition"."draft" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "acquisition"."draft" ADD CONSTRAINT "draft_failed_has_reason" CHECK ("acquisition"."draft"."state" <> 'failed' or "acquisition"."draft"."failure_reason" is not null);