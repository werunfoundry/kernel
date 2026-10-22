/**
 * acquisition/runtime — acknowledging what protection cannot reach, by name.
 *
 * - **An uncovered customer** (decision 0034): a protected customer with no
 *   key on any of its rows is protected by nothing, and stops every run that
 *   reads protection.
 * - **An unmatched account** (decision 0068): a protected account known by
 *   the source's own identifier alone can be matched against no company on
 *   record, and stops every enrolment.
 *
 * A person may acknowledge either: name it, and say in words why it may
 * stay so. Runs then go on, and say which acknowledged ones they could not
 * protect. There is no acknowledgement of all of them, or of any to come: a
 * new one stops the run again until it is named.
 *
 * Two kinds of function here, and the split is the rule:
 *
 * - `readAcknowledged` is read by every run that reads protection.
 * - `acknowledgeUncovered` and `withdrawAcknowledgement` are written by a
 *   person, through `kernel-acknowledge`, each in its own recorded run with
 *   the person as its actor. No run calls them — a test reads the runs'
 *   sources to hold that — because an acknowledgement a run could make for
 *   itself would be a run deciding its own protection.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";

import { protectionAcknowledgement } from "../db/schema.js";

/** The customers standing acknowledged as uncovered. Reads only. */
export async function readAcknowledged(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ customerId: protectionAcknowledgement.customerId })
    .from(protectionAcknowledgement)
    .where(and(isNull(protectionAcknowledgement.withdrawnAt), isNotNull(protectionAcknowledgement.customerId)));
  return new Set(rows.map((r) => r.customerId!));
}

/** The accounts standing acknowledged as unmatched (0068). Reads only. */
export async function readAcknowledgedAccounts(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ accountId: protectionAcknowledgement.accountId })
    .from(protectionAcknowledgement)
    .where(and(isNull(protectionAcknowledgement.withdrawnAt), isNotNull(protectionAcknowledgement.accountId)));
  return new Set(rows.map((r) => r.accountId!));
}

/** A customer, uncovered (0034), or an account, unmatched (0068): what an acknowledgement names. */
export type Named = { customerId: string } | { accountId: string };

export interface Acknowledgement {
  customerId: string | null;
  accountId: string | null;
  note: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
}

/** Every standing acknowledgement, for a person to read. */
export async function listAcknowledged(db: Database): Promise<Acknowledgement[]> {
  const rows = await db
    .select({
      customerId: protectionAcknowledgement.customerId,
      accountId: protectionAcknowledgement.accountId,
      note: protectionAcknowledgement.note,
      acknowledgedBy: protectionAcknowledgement.actorId,
      acknowledgedAt: protectionAcknowledgement.acknowledgedAt,
    })
    .from(protectionAcknowledgement)
    .where(isNull(protectionAcknowledgement.withdrawnAt));
  return rows;
}

const required = (value: string, what: string) => {
  if (value.trim() === "") throw new Error(`${what} is required: an acknowledgement says who, what it names and why`);
  return value.trim();
};

/**
 * A person acknowledges a customer as uncovered (0034), or an account as
 * unmatched (0068). Recorded as its own run, with the person as actor.
 * Acknowledging what stands acknowledged changes nothing, and says so.
 */
export async function acknowledge(db: Database, input: Named & { note: string; by: string }): Promise<{ runId: string; acknowledged: boolean }> {
  const name = "customerId" in input ? { customerId: required(input.customerId, "the customer") } : { accountId: required(input.accountId, "the account") };
  const note = required(input.note, "the reason");
  const by = required(input.by, "who acknowledges");
  const open = await openRun(db, { processKey: "acquisition.protection.acknowledge", trigger: "cli", actor: { type: "human", id: by }, dryRun: false });
  try {
    const written = await db
      .insert(protectionAcknowledgement)
      .values({ ...name, note, actorType: "human", actorId: by, runId: open.id })
      .onConflictDoNothing()
      .returning({ id: protectionAcknowledgement.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, acknowledged: written.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** A person withdraws an acknowledgement: what it named stops runs again. */
export async function withdraw(db: Database, input: Named & { by: string }): Promise<{ runId: string; withdrawn: boolean }> {
  const named =
    "customerId" in input
      ? eq(protectionAcknowledgement.customerId, required(input.customerId, "the customer"))
      : eq(protectionAcknowledgement.accountId, required(input.accountId, "the account"));
  const by = required(input.by, "who withdraws");
  const open = await openRun(db, { processKey: "acquisition.protection.withdraw", trigger: "cli", actor: { type: "human", id: by }, dryRun: false });
  try {
    const changed = await db
      .update(protectionAcknowledgement)
      .set({ withdrawnAt: new Date(), withdrawnBy: by, withdrawnRunId: open.id })
      .where(and(named, isNull(protectionAcknowledgement.withdrawnAt)))
      .returning({ id: protectionAcknowledgement.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, withdrawn: changed.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** A customer acknowledged as uncovered (0034). */
export const acknowledgeUncovered = (db: Database, input: { customerId: string; note: string; by: string }) => acknowledge(db, input);

/** A customer's acknowledgement withdrawn: it stops runs again. */
export const withdrawAcknowledgement = (db: Database, input: { customerId: string; by: string }) => withdraw(db, input);
