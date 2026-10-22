/**
 * acquisition/runtime — the steps a sequencer sent, pulled (0051's verb 2,
 * 0064 §5) and recorded as outbound touches.
 *
 * For each sequencer that declares the verb served, as its own run: read the
 * sends after its cursor, and for each one write
 *
 * - **the touch**, once, through the relations write path: a send read again
 *   is a replay, by the provider's own id. The adapter reads back behind its
 *   cursor, because its record may list a send late (`Sequencer.pullTouches`);
 * - **its message**, when the send is a step of an enrolment that carries the
 *   kernel's messages: the enrolment's plan names the message of each step
 *   (0064 §2), and the touch is tied to it and to its experiment;
 * - **whether it was asked for**, from that plan. A send no plan names — an
 *   enrolment without messages, a send the provider made on its own — is
 *   recorded unsolicited: the cap that reads it then errs toward refusing,
 *   never toward letting through (0064 §3).
 *
 * A send to someone not on record is counted and not written: a touch names
 * a person, and nobody is created from a send.
 *
 * The cursor moves with the touches, in the same transaction: a pull that
 * stops leaves it where the last stored page left it. A read that carries a
 * send that fails its check stores nothing.
 *
 * A dry run reads and checks, and writes nothing.
 */

import { and, eq } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import { checkIdentity, normalizeIdentity } from "@werunfoundry/core/identity";
import type { OpenRun } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { message } from "@werunfoundry/relations/db/schema";
import { findPerson, recordTouch } from "@werunfoundry/relations/runtime/record";

import type { Sequencer } from "../contracts/sequencer.js";
import { checkDeclaration } from "../contracts/sequencer.js";
import { enrolment, inboundCursor } from "../db/schema.js";
import { CONTRACTS } from "./enrol.js";
import type { PullDeps, PullRequest } from "./inbound.js";

export interface TouchesReport {
  provider: string;
  runId: string;
  read: number;
  complete: boolean;
  recorded: number;
  replayed: number;
  /** Tied to the message an enrolment's plan names for that step. */
  matched: number;
  unknownPeople: number;
  cursor?: string;
  stoppedBy?: string;
}

class Stop extends Error {}

/**
 * The cursor's row: the sequencer's name, apart from an inbound source's of
 * the same provider, which keeps its own.
 */
export const touchesCursorOf = (provider: string) => `${provider}#touches`;

export async function pullTouches(deps: PullDeps, request: Pick<PullRequest, "dryRun" | "actor" | "trigger">): Promise<TouchesReport[]> {
  const reports: TouchesReport[] = [];
  for (const sequencer of deps.registry.all<Sequencer>(CONTRACTS.sequencer)) {
    if (!sequencer.declares || sequencer.declares.pullTouches?.serves === "no") continue;
    reports.push(await pullOne(deps, request, sequencer));
  }
  return reports;
}

async function pullOne(deps: PullDeps, request: Pick<PullRequest, "dryRun" | "actor" | "trigger">, sequencer: Sequencer): Promise<TouchesReport> {
  const { db } = deps;
  const open: OpenRun = await openRun(db, { processKey: `acquisition.touches.${sequencer.provider}`, trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const ctx: CallContext = open.context;
  const report: TouchesReport = { provider: sequencer.provider, runId: open.id, read: 0, complete: false, recorded: 0, replayed: 0, matched: 0, unknownPeople: 0 };
  const key = touchesCursorOf(sequencer.provider);
  try {
    const issues = checkDeclaration(sequencer.declares, sequencer).filter((i) => i.severity === "error");
    if (issues.length > 0) throw new Stop(`the sequencer declares itself in a form the kernel cannot read, so nothing was pulled: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`);
    const [held] = await db.select({ cursor: inboundCursor.cursor }).from(inboundCursor).where(eq(inboundCursor.provider, key));
    const read = await sequencer.pullTouches!(held?.cursor ? { after: held.cursor } : {}, ctx);
    if (!read.ok) throw new Stop(`the sequencer's sends could not be read: ${read.error.code}: ${read.error.message}`);
    report.read = read.value.items.length;
    report.complete = read.value.complete;
    for (const s of read.value.items) {
      const wrong: string[] = [];
      if (!s.providerEventId) wrong.push("it has no id of its own");
      if (Number.isNaN(Date.parse(s.occurredAt))) wrong.push(`"${s.occurredAt}" is not a time`);
      if (!deps.declared.channels.has(s.channel)) wrong.push(`"${s.channel}" is not a declared channel`);
      for (const i of checkIdentity(s.person, deps.identity)) if (i.severity === "error") wrong.push(i.message);
      if (wrong.length > 0) throw new Stop(`send ${s.providerEventId || "(no id)"} refused, nothing stored: ${wrong.join("; ")}`);
    }
    if (!request.dryRun) {
      await db.transaction(async (tx) => {
        for (const s of read.value.items) {
          const found = await findPerson(tx, normalizeIdentity(s.person, deps.identity));
          if (!("id" in found)) {
            report.unknownPeople++;
            continue;
          }
          // The step's message, by the enrolment's plan (0064 §2, §5).
          let planned: { messageId: string; unsolicited: boolean } | undefined;
          if (s.sequenceKey && s.step !== undefined) {
            const [row] = await tx
              .select({ plan: enrolment.plan })
              .from(enrolment)
              .where(and(eq(enrolment.personId, found.id), eq(enrolment.sequenceKey, s.sequenceKey)));
            planned = row?.plan?.find((p) => p.step === s.step);
          }
          const [said] = planned ? await tx.select({ experimentId: message.experimentId }).from(message).where(eq(message.id, planned.messageId)) : [];
          const touched = await recordTouch(tx, {
            personId: found.id,
            channel: s.channel,
            direction: "outbound",
            unsolicited: planned ? planned.unsolicited : true,
            provider: sequencer.provider,
            providerEventId: s.providerEventId,
            occurredAt: new Date(s.occurredAt),
            ...(s.sender ? { sender: s.sender } : {}),
            ...(planned ? { messageId: planned.messageId } : {}),
            ...(said?.experimentId ? { experimentId: said.experimentId } : {}),
            actor: request.actor,
            runId: open.id,
          });
          if (!touched.recorded) {
            report.replayed++;
            continue;
          }
          report.recorded++;
          if (planned) report.matched++;
        }
        if (read.value.cursor) {
          await tx
            .insert(inboundCursor)
            .values({ provider: key, cursor: read.value.cursor, runId: open.id })
            .onConflictDoUpdate({ target: inboundCursor.provider, set: { cursor: read.value.cursor, runId: open.id, updatedAt: new Date() } });
        }
      });
    }
    if (read.value.cursor) report.cursor = read.value.cursor;
    if (!report.complete) throw new Stop("the sequencer read only part of its sends; what it read is stored, and the next pull reads on from there");
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
