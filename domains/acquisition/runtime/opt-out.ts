/**
 * acquisition/runtime — a person records that someone asked to stop, read in
 * a reply (decision 0065 §3): what `kernel-opt-out` writes, and what it stops.
 *
 * Where a provider does not class a reply asking to stop as an unsubscribe,
 * and the shipped one does not, a person does — never the adapter, never
 * the kernel: a stop recognised in free text fails silently (0065). The
 * person reads the reply where it arrived; this records their reading.
 *
 * It writes, in one run with the person as its actor:
 *
 * - **the opt-out**, on `person.opted_out_at`, at the moment the person
 *   asked: what the one reader reads (0055), never the register, which only
 *   an erasure writes (0062). One already recorded is kept as it is;
 * - **the event** `acquisition.unsubscribe`, keyed by the run, so that who
 *   recorded it, and when, is kept. Its payload holds the person's id and
 *   nothing else of them: an event payload is append-only and an erasure
 *   does not reach it (`NOT_REACHED`), so no address and none of their words.
 *
 * Then, as every opt-out read from a source is (0039, 0051), each enrolment
 * still running for someone who opted out is suspended at its sequencer,
 * outside the transaction: a provider call cannot be rolled back with it.
 */

import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { recordEvent } from "@werunfoundry/core/runtime/event";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import { recordOptOut } from "@werunfoundry/relations/runtime/record";

import { suspendOptedOut } from "./suspend.js";

/** The source this command's events are stored under: a person at a terminal. */
export const TERMINAL = "terminal";

export interface OptOutRecorded {
  runId: string;
  /** False when the person's opt-out was already on record: the first moment stands. */
  recorded: boolean;
  stopped: { suspended: number; notHeld: number; byAddress: number; refused: string[] };
}

export async function recordOptOutRead(
  deps: { db: Database; registry: Registry; eventTypes: ReadonlySet<string> },
  input: { personId: string; at: Date; by: string; trigger: Trigger },
): Promise<OptOutRecorded> {
  const by = input.by.trim();
  if (!by) throw new Error("who records it is required: recording an objection is a person's act");
  const open = await openRun(deps.db, { processKey: "acquisition.opt-out.record", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const recorded = await deps.db.transaction(async (tx) => {
      const r = await recordOptOut(tx, input.personId, input.at);
      await recordEvent(
        tx,
        { kind: "acquisition.unsubscribe", provider: TERMINAL, providerEventId: open.id, occurredAt: input.at, payload: { personId: input.personId, recordedBy: by }, runId: open.id },
        deps.eventTypes,
      );
      return r.recorded;
    });
    const s = await suspendOptedOut({ db: deps.db, registry: deps.registry }, open.context);
    const stopped = { suspended: s.suspended, notHeld: s.notHeld, byAddress: s.byAddress, refused: s.refused };
    await open.finish(
      stopped.refused.length > 0
        ? { status: "partial", error: `recorded; not every enrolment could be stopped at its provider: ${stopped.refused.join("; ")}`.slice(0, 500) }
        : { status: "succeeded" },
    );
    return { runId: open.id, recorded, stopped };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
