/**
 * A person attests that an enrolment can no longer send (decision 0056).
 *
 * The way out of an erasure refused in one of the four cases retrying cannot
 * fix, and nowhere else. Three are in the instance's configuration and the
 * kernel sees them as `kernel-erase` would: no sequencer takes the channel,
 * the one that does is another provider, or it cannot suspend. The fourth —
 * a provider that will never answer again — looks like a timeout, so it opens
 * only for an enrolment an erasure was already refused on, and the person
 * attests the case too. Where a suspension can still be tried, it is refused:
 * retrying is the remedy.
 *
 * What the person affirms differs by case, and is kept in their words: that
 * they stopped this person at the provider by hand, and how; or that the
 * account is closed and nothing can send. It names one enrolment. It is kept
 * in `suspension_attestation`, never in the column for what a provider read
 * back, under a run the person opened — whose attribution says who (0047).
 * It can be false, as any attestation can; the registry says who gave it.
 *
 * A pending row is stopped as it stands, `pending` → `suspended`, and never
 * recorded `enrolled` on the way: that would write a provider's confirmation
 * nobody gave (0060). The trigger allows the move under an attestation only.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";

import { enrolment, suspensionRefusal } from "../db/schema.js";
import type { RefusalReason } from "./suspend.js";
import { reachFor } from "./suspend.js";

/** What the person affirms. Two facts, two forms: never one formula for both. */
export type Attested = { kind: "stopped_by_hand"; how: string } | { kind: "account_closed"; said: string };

export type Attestation =
  | { recorded: true; runId: string; case: RefusalReason }
  | { refused: string };

export async function attestStop(
  deps: { db: Database; registry: Registry },
  input: { enrolmentId: string; by: string; attested: Attested; trigger: Trigger },
): Promise<Attestation> {
  const by = input.by.trim();
  if (by === "") return { refused: "who attests is required: an attestation is a person's act" };
  const words = (input.attested.kind === "stopped_by_hand" ? input.attested.how : input.attested.said).trim();
  if (words === "") return { refused: "an attestation says what was done, in the person's words" };

  const [row] = await deps.db
    .select({ id: enrolment.id, state: enrolment.state, channel: enrolment.channel, provider: enrolment.provider, personId: enrolment.personId })
    .from(enrolment)
    .where(eq(enrolment.id, input.enrolmentId));
  if (!row) return { refused: `no enrolment ${input.enrolmentId} is on record` };
  if (row.state === "suspended") return { refused: "this enrolment is already suspended: there is nothing to attest" };
  if (row.state === "refused") return { refused: "the provider refused this enrolment: nothing of it was ever sent, and there is nothing to attest" };
  if (row.personId === null) return { refused: "this enrolment names nobody any more: its person is erased" };

  // The case, as the kernel sees it now — or, for the one it cannot see, as an erasure met it.
  let seen: RefusalReason;
  const reach = reachFor(deps.registry, row);
  if ("refused" in reach) seen = reach.refused.reason;
  else {
    const [met] = await deps.db.select({ id: suspensionRefusal.id }).from(suspensionRefusal).where(and(eq(suspensionRefusal.enrolmentId, row.id), eq(suspensionRefusal.reason, "unanswered"))).limit(1);
    if (!met) {
      return {
        refused: `no attestation is open: the sequencer "${reach.sequencer.provider}" can suspend this enrolment, and no erasure was refused on it. Run the erasure; if it is refused, running it again is the remedy (decision 0056)`,
      };
    }
    seen = "unanswered";
  }

  const open = await openRun(deps.db, { processKey: "acquisition.enrolment.attest", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    await deps.db.transaction(async (tx) => {
      // As it stands (0060): an enrolled row, or a pending one, which a
      // person's word never makes `enrolled` — nobody confirmed it.
      const done = await tx
        .update(enrolment)
        .set({
          state: "suspended",
          suspensionAskedAt: new Date(),
          suspensionRunId: open.id,
          suspensionAttestation: { case: seen, ...input.attested, ...(input.attested.kind === "stopped_by_hand" ? { how: words } : { said: words }) },
          updatedAt: sql`now()`,
        })
        .where(and(eq(enrolment.id, row.id), eq(enrolment.state, row.state)))
        .returning({ id: enrolment.id });
      if (done.length !== 1) throw new Error("the enrolment changed while it was being attested; nothing was recorded");
    });
    await open.finish({ status: "succeeded" });
    return { recorded: true, runId: open.id, case: seen };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
