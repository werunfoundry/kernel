/**
 * What `acquisition` does before a person is erased (decision 0056): it
 * suspends every enrolment a provider may still hold, so that the row the
 * erasure then anonymises is the proof that they were stopped before they
 * were forgotten.
 *
 * - `enrolled` is suspended through the sequencer bound to its channel.
 * - `pending` is asked of the provider too: one it holds is recorded
 *   enrolled, then suspended; one it does not hold stays pending.
 * - `refused` and `suspended` leave nothing to stop.
 *
 * Every row is tried, so that a retry has less left to do; any refusal refuses
 * the erasure. Each refusal is kept in `acquisition.suspension_refusal` under
 * the erasure's run: what opens a person's attestation where a provider no
 * longer answers. A plan calls the adapters as dry runs and records nothing.
 *
 * The core loads this module by the name `domain.yaml` gives it, and calls
 * `beforeErasure`; it imports nothing of this domain.
 */

import { and, eq, inArray } from "drizzle-orm";

import type { BeforeErasure, BeforeErasureAct, BeforeErasureRefusal } from "@werunfoundry/core/runtime/erase";

import { enrolment, suspensionRefusal } from "../db/schema.js";
import type { Suspendable } from "./suspend.js";
import { suspendEnrolment } from "./suspend.js";

export const beforeErasure: BeforeErasure = async ({ db, registry, subjectId, keys, runId, plan }) => {
  const rows = (await db
    .select({
      id: enrolment.id,
      sequenceKey: enrolment.sequenceKey,
      channel: enrolment.channel,
      idempotencyKey: enrolment.idempotencyKey,
      state: enrolment.state,
      provider: enrolment.provider,
    })
    .from(enrolment)
    .where(and(eq(enrolment.personId, subjectId), inArray(enrolment.state, ["enrolled", "pending"])))
    .orderBy(enrolment.sequenceKey)) as Suspendable[];

  const person = { subject: "person", keys };
  // A plan is not a run: its calls are dry runs, and adapters only cite the id.
  const ctx = { runId: runId ?? "plan", actor: { type: "human" as const }, dryRun: plan };
  const tally = new Map<string, BeforeErasureAct>();
  const count = (what: string, through?: string) => {
    const key = `${what}\u0000${through ?? ""}`;
    const act = tally.get(key) ?? { what, rows: 0, ...(through ? { through } : {}) };
    act.rows++;
    tally.set(key, act);
  };
  const refused: BeforeErasureRefusal[] = [];

  for (const row of rows) {
    const r = await suspendEnrolment({ db, registry }, row, person, ctx, "the person is being erased (decision 0056)");
    if ("suspended" in r) count("enrolments suspended at the provider, read back and recorded", r.through);
    else if ("notHeld" in r) count("enrolments the provider no longer holds: nothing to stop", r.through);
    else if ("would" in r) count(r.would === "suspend" ? "enrolments it would suspend" : "enrolments the provider holds nothing of", r.through);
    else {
      const { reason, ...said } = r.refused;
      refused.push({ contract: "sequencer", ...said, answered: `${said.answered} — enrolment ${row.id}, in "${row.sequenceKey}"` });
      if (!plan) await db.insert(suspensionRefusal).values({ enrolmentId: row.id, reason, ...(runId ? { runId } : {}) });
    }
  }
  return { acts: [...tally.values()], refused };
};
