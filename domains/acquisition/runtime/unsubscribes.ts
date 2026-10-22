/**
 * acquisition/runtime — the unsubscribes a sequencer holds, pulled (0051's
 * verb 4) and applied as any opt-out is (0017, 0041).
 *
 * For each sequencer that declares the verb served, as its own run: read
 * every unsubscribe it holds for its sequences, and for each one write
 *
 * - **the event**, once, through the core's one write path. A second read of
 *   the same unsubscribe is a replay: the provider gives no date to read
 *   after, so every pull reads them all again (`Sequencer.pullUnsubscribes`);
 * - **the opt-out**, for someone already recorded. Nobody is created from an
 *   event; one about nobody recorded is stored and counted, not tied to a
 *   person.
 *
 * No touch is written: an unsubscribe is not the person reaching us, and the
 * reactive lane must not take it for a licence (0042).
 *
 * Once stored, every enrolment still running for someone who opted out is
 * suspended at its sequencer (0051), outside any transaction — the same act
 * the inbound pull ends with. One that cannot be stops the run, and the next
 * pull tries again.
 *
 * **0065: what this verb is, and what it is not.** It reads what the
 * provider recorded: a click on the provider's link or its header. A reply
 * asking to stop is not one, unless the provider is proved to class it so
 * (`classesStop`); measured once, the shipped adapter's provider classed it
 * "not interested" and wrote no unsubscribe.
 *
 * A dry run reads and checks, and writes nothing.
 */

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { OpenRun } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { recordEvent } from "@werunfoundry/core/runtime/event";
import { findPerson, recordOptOut } from "@werunfoundry/relations/runtime/record";

import { checkInboundEvent } from "../contracts/inbound.js";
import type { Sequencer } from "../contracts/sequencer.js";
import { checkDeclaration } from "../contracts/sequencer.js";
import { CONTRACTS } from "./enrol.js";
import type { PullDeps, PullRequest } from "./inbound.js";
import { suspendOptedOut } from "./suspend.js";

export interface UnsubscribesReport {
  provider: string;
  runId: string;
  read: number;
  /** Whether the adapter read every page; when not, the run says so and fails. */
  complete: boolean;
  recorded: number;
  replayed: number;
  optOuts: number;
  unknownPeople: number;
  stopped: { suspended: number; notHeld: number; byAddress: number; would: number };
  stoppedBy?: string;
}

class Stop extends Error {}

/**
 * Every bound sequencer whose declaration serves the unsubscribes pull,
 * pulled one after the other. One that says it does not serve it is skipped,
 * and its declaration says why (`kernel-enrol` prints it). One whose
 * declaration cannot be read is not skipped: its run fails and says why, so
 * unsubscribes nobody reads are seen, not assumed read.
 */
export async function pullUnsubscribes(deps: PullDeps, request: Pick<PullRequest, "dryRun" | "actor" | "trigger">): Promise<UnsubscribesReport[]> {
  const reports: UnsubscribesReport[] = [];
  for (const sequencer of deps.registry.all<Sequencer>(CONTRACTS.sequencer)) {
    if (!sequencer.declares || sequencer.declares.pullUnsubscribes?.serves === "no") continue;
    reports.push(await pullOne(deps, request, sequencer));
  }
  return reports;
}

async function pullOne(deps: PullDeps, request: Pick<PullRequest, "dryRun" | "actor" | "trigger">, sequencer: Sequencer): Promise<UnsubscribesReport> {
  const { db } = deps;
  const open: OpenRun = await openRun(db, { processKey: `acquisition.unsubscribes.${sequencer.provider}`, trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const ctx: CallContext = open.context;
  const report: UnsubscribesReport = { provider: sequencer.provider, runId: open.id, read: 0, complete: false, recorded: 0, replayed: 0, optOuts: 0, unknownPeople: 0, stopped: { suspended: 0, notHeld: 0, byAddress: 0, would: 0 } };
  try {
    const issues = checkDeclaration(sequencer.declares, sequencer).filter((i) => i.severity === "error");
    if (issues.length > 0) throw new Stop(`the sequencer declares itself in a form the kernel cannot read, so nothing was pulled: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`);
    const read = await sequencer.pullUnsubscribes!(ctx);
    if (!read.ok) throw new Stop(`the sequencer's unsubscribes could not be read: ${read.error.code}: ${read.error.message}`);
    report.read = read.value.items.length;
    report.complete = read.value.complete;
    for (const e of read.value.items) {
      const issues = checkInboundEvent(e, { eventTypes: deps.declared.eventTypes, identity: deps.identity });
      if (e.type !== "acquisition.unsubscribe") issues.push({ severity: "error", at: "type", message: `the unsubscribes pull returned "${e.type}"` });
      if (issues.length > 0) throw new Stop(`event ${e.providerEventId || "(no id)"} refused, nothing stored: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`);
    }
    if (!request.dryRun) {
      await db.transaction(async (tx) => {
        for (const e of read.value.items) {
          const occurredAt = new Date(e.occurredAt);
          const stored = await recordEvent(tx, { kind: e.type, provider: sequencer.provider, providerEventId: e.providerEventId, occurredAt, payload: { ...e }, runId: open.id }, deps.declared.eventTypes);
          if (!stored.recorded) {
            report.replayed++;
            continue;
          }
          report.recorded++;
          const found = e.subject.subject === "person" ? await findPerson(tx, e.subject) : { none: true as const };
          if (!("id" in found)) {
            report.unknownPeople++;
            continue;
          }
          if ((await recordOptOut(tx, found.id, occurredAt)).recorded) report.optOuts++;
        }
      });
    }
    // Applied at the provider once stored, as the inbound pull does.
    const stopped = await suspendOptedOut({ db, registry: deps.registry }, ctx);
    report.stopped = { suspended: stopped.suspended, notHeld: stopped.notHeld, byAddress: stopped.byAddress, would: stopped.would };
    if (stopped.refused.length > 0) throw new Stop(`people who opted out could not be stopped at their provider; the next pull tries again: ${stopped.refused.join("; ")}`);
    if (!report.complete) throw new Stop("the sequencer read only part of its unsubscribes; what it read is stored, and the next pull reads them all again");
    await open.finish({ status: "succeeded" });
  } catch (thrown) {
    if (!(thrown instanceof Stop)) {
      await open.finish({ status: "failed", error: (thrown as Error).message.slice(0, 500) }).catch(() => {});
      throw thrown;
    }
    report.stoppedBy = thrown.message;
    await open.finish({ status: report.recorded > 0 ? "partial" : "failed", error: thrown.message.slice(0, 500) }).catch(() => {});
  }
  return report;
}
