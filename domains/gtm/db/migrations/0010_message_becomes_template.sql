-- HAND-CORRECTED: this file is not what `drizzle-kit generate` writes.
-- The generator writes:
--
--   ALTER TABLE "gtm"."message" DISABLE ROW LEVEL SECURITY;
--   DROP TABLE "gtm"."message" CASCADE;
--   ALTER TABLE "gtm"."draft" DROP CONSTRAINT "draft_message_id_message_id_fk";
--   ALTER TABLE "gtm"."draft" DROP COLUMN "message_id";
--
-- which fails on every database: DROP TABLE ... CASCADE takes the draft's
-- foreign key with it, and the DROP CONSTRAINT after it finds nothing to
-- drop. Corrected by hand: the draft's reference first, then the table,
-- without CASCADE; and the DO block, which the generator does not write
-- either, stops instead of dropping rows. Regenerating this migration
-- reintroduces the order; `runtime/template.test.ts` fails until it is fixed.
--
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