/**
 * gtm/runtime — acknowledging an uncovered customer (decision 0034).
 *
 * A protected customer with no key on any of its rows is protected by
 * nothing, and stops every run that reads protection. A person may
 * acknowledge it: say, in words, why it may stay uncovered. Runs then go on,
 * and say which acknowledged customers they could not protect.
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

import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";

import { protectionAcknowledgement } from "../db/schema.js";

/** The customers standing acknowledged as uncovered. Reads only. */
export async function readAcknowledged(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ customerId: protectionAcknowledgement.customerId })
    .from(protectionAcknowledgement)
    .where(isNull(protectionAcknowledgement.withdrawnAt));
  return new Set(rows.map((r) => r.customerId));
}

export interface Acknowledgement {
  customerId: string;
  note: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
}

/** Every standing acknowledgement, for a person to read. */
export async function listAcknowledged(db: Database): Promise<Acknowledgement[]> {
  const rows = await db
    .select({
      customerId: protectionAcknowledgement.customerId,
      note: protectionAcknowledgement.note,
      acknowledgedBy: protectionAcknowledgement.actorId,
      acknowledgedAt: protectionAcknowledgement.acknowledgedAt,
    })
    .from(protectionAcknowledgement)
    .where(isNull(protectionAcknowledgement.withdrawnAt));
  return rows;
}

const required = (value: string, what: string) => {
  if (value.trim() === "") throw new Error(`${what} is required: an acknowledgement says who, which customer and why`);
  return value.trim();
};

/**
 * A person acknowledges a customer as uncovered. Recorded as its own run,
 * with the person as actor. Acknowledging a customer that stands
 * acknowledged changes nothing, and says so.
 */
export async function acknowledgeUncovered(
  db: Database,
  input: { customerId: string; note: string; by: string },
): Promise<{ runId: string; acknowledged: boolean }> {
  const customerId = required(input.customerId, "the customer");
  const note = required(input.note, "the reason");
  const by = required(input.by, "who acknowledges");
  const open = await openRun(db, { processKey: "gtm.protection.acknowledge", trigger: "cli", actor: { type: "human", id: by }, dryRun: false });
  try {
    const written = await db
      .insert(protectionAcknowledgement)
      .values({ customerId, note, actorType: "human", actorId: by, runId: open.id })
      .onConflictDoNothing()
      .returning({ id: protectionAcknowledgement.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, acknowledged: written.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** A person withdraws an acknowledgement: the customer stops runs again. */
export async function withdrawAcknowledgement(
  db: Database,
  input: { customerId: string; by: string },
): Promise<{ runId: string; withdrawn: boolean }> {
  const customerId = required(input.customerId, "the customer");
  const by = required(input.by, "who withdraws");
  const open = await openRun(db, { processKey: "gtm.protection.withdraw", trigger: "cli", actor: { type: "human", id: by }, dryRun: false });
  try {
    const changed = await db
      .update(protectionAcknowledgement)
      .set({ withdrawnAt: new Date(), withdrawnBy: by, withdrawnRunId: open.id })
      .where(and(eq(protectionAcknowledgement.customerId, customerId), isNull(protectionAcknowledgement.withdrawnAt)))
      .returning({ id: protectionAcknowledgement.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, withdrawn: changed.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
