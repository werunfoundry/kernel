/**
 * What erasing a person writes here, inside the erasure's transaction
 * (decisions 0052, 0062, 0063): the objection, as one fingerprint per key,
 * and nothing else.
 *
 * Who gets entries is whoever objected, not whoever was erased. A person
 * whose opt-out is on record leaves one entry per key the erasure gathered.
 * A person who had not opted out leaves entries only if the request includes
 * not being contacted, which `kernel-erase` asks: the opt-out is then
 * recorded first, at the run's start, and the entries follow. Otherwise
 * nothing of them survives, as 0049 has it.
 *
 * The entries are computed from the keys the transaction is about to
 * delete, so they commit or roll back with the deletion. Nothing reads them
 * yet: the one reader is 0055's. They are computed as it will compute them,
 * and are readable the day it arrives.
 */

import { eq, sql } from "drizzle-orm";

import type { BeforeErasureAct, DuringErasure } from "@werunfoundry/core/runtime/erase";

import { person, suppression } from "../db/schema.js";
import { recordOptOut } from "./record.js";

export const duringErasure: DuringErasure = async ({ tx, subjectId, keys, run, objects, fingerprints, plan }) => {
  const acts: BeforeErasureAct[] = [];

  // Said on every erasure, planned or done (0063): the entries a lost secret
  // no longer protects. Erasure goes on; contact stops at the reader.
  if (fingerprints.missing.length > 0) {
    const [lost] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(suppression)
      .where(sql`${suppression.chain} && ${`{${fingerprints.missing.join(",")}}`}::text[]`);
    acts.push({
      what: `entries in the register keyed under a version whose secret is not set (${fingerprints.missing.join(", ")}): they protect nobody from now on (decision 0063)`,
      rows: Number(lost!.n),
    });
  }

  const [who] = await tx.select({ optedOutAt: person.optedOutAt }).from(person).where(eq(person.id, subjectId));
  if (!who) return { acts };
  const onRecord = who.optedOutAt !== null;
  const objected = onRecord || objects === true;

  if (plan) {
    if (objected) {
      acts.push({ what: `entries it would write in the register, one per key: ${onRecord ? "an opt-out is on record" : "the request includes not being contacted"} (decision 0052)`, rows: keys.length });
    } else if (objects === undefined) {
      acts.push({ what: "entries it would write in the register, one per key, if the request includes not being contacted; none if it does not (decision 0052)", rows: keys.length });
    } else {
      acts.push({ what: "entries it would write in the register: none, no opt-out is on record and the request includes none (decision 0052)", rows: 0 });
    }
    return { acts };
  }

  if (!objected) {
    acts.push({ what: "entries written in the register: none, no opt-out is on record and the request includes none, so nothing of the person survives (decision 0052)", rows: 0 });
    return { acts };
  }
  // At the run's start, under the run (0052): the entries' time is never
  // earlier than the objection it keeps.
  if (!onRecord) await recordOptOut(tx, subjectId, run!.startedAt);

  const rows = keys.map((k) => ({ ...fingerprints.fingerprint(k), writtenAt: run!.startedAt, runId: run!.id }));
  if (rows.length === 0) {
    acts.push({ what: "entries written in the register: none, the person objected and has no key to be recognised by", rows: 0 });
    return { acts };
  }
  // A key already there — shared with someone erased before, a generic
  // address — keeps the entry it has: the unique on the fingerprint.
  const written = await tx.insert(suppression).values(rows).onConflictDoNothing({ target: suppression.fingerprint }).returning({ id: suppression.id });
  acts.push({ what: "entries written in the register, one per key of a person who objected (decision 0052)", rows: written.length });
  if (written.length < rows.length) {
    acts.push({ what: "keys already in the register, from someone erased before under the same key: the entry there stands", rows: rows.length - written.length });
  }
  return { acts };
};
