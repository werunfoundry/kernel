-- Decision 0038: "message" means what is sent to a person, and is recorded in
-- `relations`. What this table held was a template — one step of one variant,
-- no recipient — and it becomes `gtm.template`. Nothing in the engine wrote it
-- or `draft.message_id`, so they are replaced rather than renamed; on a
-- database where something did, this stops rather than drop it.
DO $$
BEGIN
  -- A draft can only point at a row of this table, so this covers both.
  IF EXISTS (SELECT 1 FROM "gtm"."message") THEN
    RAISE EXCEPTION 'gtm.message holds rows: they are not dropped silently (decision 0038)'
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint
-- The draft's reference goes first: dropping the table with CASCADE would
-- take the constraint with it, and the explicit drop after would fail.
ALTER TABLE "gtm"."draft" DROP CONSTRAINT "draft_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "gtm"."draft" DROP COLUMN "message_id";--> statement-breakpoint
DROP TABLE "gtm"."message";