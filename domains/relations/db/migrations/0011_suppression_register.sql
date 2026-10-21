-- Decision 0052: the register of objections that outlive an erasure. It holds
-- four fields (0052, *Rules out*): the fingerprint, the secret's version (a
-- chain since 0058, §4), the time it was written, and the run.
--
-- `id` is a fifth, and it is not one of them: it says nothing about anyone.
-- It is there because the fingerprint cannot be the primary key — the
-- rewrap of 0058, §3 changes it — and a key that changes would carry the
-- change into whatever refers to the row. Uniqueness is the fingerprint's,
-- and the unique index below holds it: one entry per fingerprint.
CREATE TABLE "relations"."suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"chain" text[] NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"run_id" uuid,
	CONSTRAINT "suppression_fingerprint_form" CHECK ("relations"."suppression"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "suppression_chain_form" CHECK (cardinality("relations"."suppression"."chain") >= 1 and array_to_string("relations"."suppression"."chain", ',') ~ '^[A-Z0-9]+(,[A-Z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "relations"."suppression" ADD CONSTRAINT "suppression_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "core"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_fingerprint_uidx" ON "relations"."suppression" USING btree ("fingerprint");--> statement-breakpoint
-- Decisions 0052 and 0058: an entry is appended, never deleted, and changed
-- in one way only.
--
-- - The schema's own change: deleting the erasure run sets `run_id` to null
--   (attribution, doctrine 4), and nothing else moves.
-- - The rewrap of a compromised version (0058, §3): the fingerprint changes,
--   and the chain grows by exactly one label at its end. The entry keeps its
--   time and its run.
--
-- Every other update is refused, and every delete. The comparison is over
-- the whole row as JSON less what each change may touch, so a column added
-- later is covered without editing this function.
CREATE FUNCTION "relations"."suppression_is_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'relations.suppression: an entry is never deleted; an objection that outlived its person outlives every later change (decisions 0052, 0058)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'run_id') = (to_jsonb(OLD) - 'run_id') AND NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'fingerprint' - 'chain') = (to_jsonb(OLD) - 'fingerprint' - 'chain')
     AND NEW.fingerprint <> OLD.fingerprint
     AND cardinality(NEW.chain) = cardinality(OLD.chain) + 1
     AND NEW.chain[1:cardinality(OLD.chain)] = OLD.chain THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'relations.suppression: an entry is not edited; the one change admitted is a rewrap, a new fingerprint under one more label at the end of its chain (decision 0058)'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "suppression_is_append_only" BEFORE UPDATE OR DELETE ON "relations"."suppression"
  FOR EACH ROW EXECUTE FUNCTION "relations"."suppression_is_append_only"();
--> statement-breakpoint
-- TRUNCATE fires no row trigger, so the one above does not stop it. This
-- table is the one whose destruction cancels, in silence, every objection
-- that outlived its person, and it is append-only by trigger, not by
-- privilege. So a truncate that would destroy an entry is refused, whether it
-- names this table or reaches it by cascade, as `truncate core.run cascade`
-- does. An empty register destroys nothing, and goes.
CREATE FUNCTION "relations"."suppression_is_not_truncated"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "relations"."suppression") THEN
    RAISE EXCEPTION 'relations.suppression: the register is not truncated; it would cancel every objection it holds, in silence (decisions 0052, 0058)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "suppression_is_not_truncated" BEFORE TRUNCATE ON "relations"."suppression"
  FOR EACH STATEMENT EXECUTE FUNCTION "relations"."suppression_is_not_truncated"();
