/**
 * Suspending one enrolment (decision 0051), as its callers need it: erasure
 * before it forgets the person (0056), and the opt-out once it is observed.
 *
 * Through the sequencer bound to the row's channel, and only through the one
 * the row was made through. The provider's answer is read back by the
 * adapter; what it read back is what the registry records, with the way and
 * the costs the adapter declared at that moment. A call that answers success
 * with nothing read back has proved nothing, and is not recorded as a stop.
 *
 * Each row is written as soon as it is stopped, never in a caller's
 * transaction: the provider's side cannot be rolled back, so the kernel's
 * record of it must not be either. A retry finds the row suspended and does
 * not ask again.
 *
 * Three refusals are of configuration, and running again will not fix them:
 * no sequencer takes the channel, the one that does is another provider, or
 * it declares that it cannot suspend. The fourth — a call that failed — may
 * be a timeout or a provider that will never answer again; the kernel cannot
 * tell which, so it says that retrying is the remedy.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import { person } from "@werunfoundry/relations/db/schema";

import type { Sequencer } from "../contracts/sequencer.js";
import { readDeclaration } from "../contracts/sequencer.js";
import { enrolment } from "../db/schema.js";
import { CONTRACTS } from "./enrol.js";

/** An enrolment as suspending it needs it. */
export interface Suspendable {
  id: string;
  sequenceKey: string;
  channel: string;
  idempotencyKey: string;
  state: "pending" | "enrolled";
  provider: string;
}

/** The reasons `acquisition.suspension_refusal` holds. */
export type RefusalReason = "unbound" | "other_provider" | "cannot_suspend" | "unanswered";

export type Suspension =
  | { suspended: true; through: string }
  /** The provider holds nothing to stop: nothing is recorded, and nothing sends. */
  | { notHeld: true; through: string }
  /** A dry run: what the live one would do. */
  | { would: "suspend" | "find nothing to stop"; through: string }
  | { refused: { reason: RefusalReason; binding: string; answered: string; retry: boolean; remedy?: string } };

const ATTEST = "once the person is stopped at the provider by hand, a person may attest it with `kernel-attest-stop` (decision 0056)";

type Refused = Extract<Suspension, { refused: unknown }>["refused"];

/**
 * The three refusals the instance's configuration makes, which running again
 * cannot fix — or the sequencer that can stop the row. What `kernel-attest-stop`
 * asks too, so that an attestation opens exactly where a suspension cannot.
 */
export function reachFor(registry: Registry, row: Pick<Suspendable, "channel" | "provider">): { refused: Refused } | { sequencer: Sequencer } {
  const sequencer = registry.forChannel<Sequencer>(CONTRACTS.sequencer, row.channel);
  if (!sequencer) {
    return { refused: { reason: "unbound", binding: `none on "${row.channel}"`, answered: `no sequencer is bound to the channel "${row.channel}" this enrolment runs on`, retry: false, remedy: `bind the sequencer "${row.provider}" to "${row.channel}"; or, ${ATTEST}` } };
  }
  if (sequencer.provider !== row.provider) {
    return { refused: { reason: "other_provider", binding: sequencer.provider, answered: `this enrolment was made through "${row.provider}", and "${sequencer.provider}" cannot stop what another provider holds`, retry: false, remedy: `bind "${row.provider}" to "${row.channel}"; or, ${ATTEST}` } };
  }
  const declared = readDeclaration(sequencer);
  const way = sequencer.declares?.suspend;
  if (!declared.suspends || !way || way.serves === "no") {
    return { refused: { reason: "cannot_suspend", binding: sequencer.provider, answered: declared.refusal ?? "it declares that it cannot suspend one person", retry: false, remedy: ATTEST } };
  }
  return { sequencer };
}

export async function suspendEnrolment(
  deps: { db: Database; registry: Registry },
  row: Suspendable,
  person: Identity,
  ctx: CallContext,
  reason: string,
): Promise<Suspension> {
  const reach = reachFor(deps.registry, row);
  if ("refused" in reach) return reach;
  const { sequencer } = reach;
  const through = `${CONTRACTS.sequencer} (${sequencer.provider})`;
  const way = sequencer.declares!.suspend as Extract<NonNullable<Sequencer["declares"]>["suspend"], { method: string }>;

  const asked = new Date();
  const r = await sequencer.withdraw({ idempotencyKey: row.idempotencyKey, person, sequenceKey: row.sequenceKey, reason }, ctx);
  if (!r.ok) return { refused: { reason: "unanswered", binding: sequencer.provider, answered: `${r.error.code}: ${r.error.message}`, retry: true } };
  if (ctx.dryRun) return { would: r.value.found ? "suspend" : "find nothing to stop", through };
  if (!r.value.found) return { notHeld: true, through };
  if (r.value.readBack === undefined) {
    return { refused: { reason: "unanswered", binding: sequencer.provider, answered: "it answered that it stopped the person, and read nothing back to show it (decision 0051)", retry: true } };
  }

  // A pending row the provider holds was enrolled: it is recorded so, then
  // suspended — the only move to `suspended` the registry allows (0051).
  if (row.state === "pending") {
    await deps.db.update(enrolment).set({ state: "enrolled", updatedAt: sql`now()` }).where(and(eq(enrolment.id, row.id), eq(enrolment.state, "pending")));
  }
  await deps.db
    .update(enrolment)
    .set({
      state: "suspended",
      suspensionAskedAt: asked,
      suspensionRunId: ctx.runId,
      suspensionReadBack: r.value.readBack,
      suspensionMethod: way.method,
      suspensionCosts: way.costs,
      updatedAt: sql`now()`,
    })
    .where(and(eq(enrolment.id, row.id), eq(enrolment.state, "enrolled")));
  return { suspended: true, through };
}

/** A recorded person as an identity, by the keys relations holds for them (0013). */
export function personIdentity(p: { email: string | null; externalId: string | null }): Identity {
  const keys: Identity["keys"] = [];
  if (p.email) keys.push({ kind: "email", value: p.email });
  const cut = p.externalId?.indexOf(":") ?? -1;
  if (p.externalId && cut > 0) keys.push({ kind: "social_profile_id", network: p.externalId.slice(0, cut), value: p.externalId.slice(cut + 1) });
  return { subject: "person", keys };
}

/**
 * Every enrolment still running for someone who opted out, suspended (0051):
 * an opt-out observed and not applied at the provider would be a contact
 * with someone who asked to stop. All of them, not only this run's, so that a
 * suspension refused once is tried again by the next run — the event that
 * brought the opt-out is not read twice.
 */
export async function suspendOptedOut(
  deps: { db: Database; registry: Registry },
  ctx: CallContext,
): Promise<{ suspended: number; notHeld: number; would: number; refused: string[] }> {
  const rows = await deps.db
    .select({
      id: enrolment.id,
      sequenceKey: enrolment.sequenceKey,
      channel: enrolment.channel,
      idempotencyKey: enrolment.idempotencyKey,
      state: enrolment.state,
      provider: enrolment.provider,
      email: person.email,
      externalId: person.externalId,
    })
    .from(enrolment)
    .innerJoin(person, eq(person.id, enrolment.personId))
    .where(and(isNotNull(person.optedOutAt), inArray(enrolment.state, ["enrolled", "pending"])))
    .orderBy(enrolment.id);
  const out = { suspended: 0, notHeld: 0, would: 0, refused: [] as string[] };
  for (const row of rows) {
    const r = await suspendEnrolment(deps, row as Suspendable, personIdentity(row), ctx, "the person opted out (decision 0041)");
    if ("suspended" in r) out.suspended++;
    else if ("notHeld" in r) out.notHeld++;
    else if ("would" in r) out.would += r.would === "suspend" ? 1 : 0;
    else out.refused.push(`enrolment ${row.id} in "${row.sequenceKey}": the sequencer bound as "${r.refused.binding}": ${r.refused.answered}`);
  }
  return out;
}
