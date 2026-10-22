/**
 * acquisition/runtime — drafting from a frozen list (decision 0050's run 1).
 *
 * `draftFromList` reads the list (sealed; nothing about consent or
 * protection is read from it: a list is a selection, never a permission,
 * 0037), reads each person's objection, composes the text of those who did
 * not object with the caller's composer, and proposes the draft, which
 * applies the objection again and the lane (0027).
 *
 * **The objection is read before the composer is called**, not only by
 * `propose` after it. A composer — an agent, a model, a service — handed the
 * address and the name of someone who objected has been handed what they
 * objected to being used for, whatever is done with the text afterwards.
 *
 * What 0050 called run 2 — a hand-over of each message — is withdrawn
 * (0064 §1): no hand-over was ever bound, and one verb reaches a person,
 * `enrol`. The approved drafts are carried by the enrolment from the same
 * list (`kernel-enrol --list`, `runtime/enrol.ts`), each written through the
 * message gate before the sequencer is called.
 */

import { eq } from "drizzle-orm";

import type { Fingerprinter } from "@werunfoundry/core/runtime/fingerprint";
import type { ActorKind, Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { person as personTable } from "@werunfoundry/relations/db/schema";
import { readList } from "@werunfoundry/relations/runtime/list";
import { readObjection } from "@werunfoundry/relations/runtime/record";

import { template } from "../db/schema.js";
import type { Gate } from "./draft.js";
import { messageKey, propose } from "./draft.js";

export { messageKey };

/** The text of one person's draft, from the template. The engine does not write copy (0027): the caller does. */
export type Compose = (
  person: { personId: string; email?: string; fullName?: string },
  template: { channel: string; step: number; subject?: string; body: string },
) => Promise<{ subject?: string; body: string }> | { subject?: string; body: string };


type Status = "succeeded" | "partial" | "failed";

/** The list, sealed, or why it cannot be read from. */
async function sealedList(db: Database, key: string) {
  const list = await readList(db, key.trim());
  if (!list) throw new Error(`no list ${key} is on record`);
  if (!list.sealedAt) throw new Error(`the list ${key} is not sealed: it is still being constituted`);
  return list;
}

/* Run 1 — from a list to drafts ------------------------------------------ */

export interface DraftRequest {
  listKey: string;
  experimentId: string;
  /** The template whose step and channel each draft takes. It belongs to the experiment. */
  templateId: string;
  compose: Compose;
  gate: Gate;
  dryRun: boolean;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
}

export interface DraftReport {
  runId: string;
  dryRun: boolean;
  status: Status;
  stoppedBy?: string;
  /** What `propose` answered for each person; on a dry run, what would be proposed. */
  drafted: { personId: string; draftId?: string; outcome: "awaiting_review" | "approved_by_lane" | "kept" | "would_propose" }[];
  /** A member nothing was drafted for, and why: a company names nobody, a refusal of the draft's gate. */
  skipped: { member: { personId?: string; companyId?: string }; reason: string }[];
}

/** `fingerprints`: what the one reader recognises the register's entries with (0055), boot's. */
export async function draftFromList(db: Database, fingerprints: Fingerprinter, request: DraftRequest): Promise<DraftReport> {
  // Read before a run is opened: a run that could not have done anything is not a run.
  const list = await sealedList(db, request.listKey);
  const [t] = await db.select().from(template).where(eq(template.id, request.templateId));
  if (!t) throw new Error(`no template ${request.templateId} is on record`);
  if (t.experimentId !== request.experimentId) throw new Error(`the template ${request.templateId} belongs to another experiment`);

  const open = await openRun(db, { processKey: "acquisition.draft", trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const report: DraftReport = { runId: open.id, dryRun: request.dryRun, status: "succeeded", drafted: [], skipped: [] };
  try {
    for (const member of list.members) {
      if (!member.personId) {
        // Finding the people at a company is sourcing's work (0031), not sending's.
        report.skipped.push({ member: { companyId: member.companyId! }, reason: "a company on a list names nobody to write to" });
        continue;
      }
      // Before anything of the person is read for the composer: an objector's
      // address never reaches it, on a dry run either.
      const objection = await readObjection(db, fingerprints, { personId: member.personId });
      if (objection.answer === "cannot_answer" && objection.stops) throw new Error(`the objection cannot be read: ${objection.why}`);
      if (objection.answer === "cannot_answer") {
        report.skipped.push({ member: { personId: member.personId }, reason: `the person is not on record: ${objection.why}` });
        continue;
      }
      if (objection.answer === "objected") {
        report.skipped.push({ member: { personId: member.personId }, reason: "the person opted out: nothing of them is handed to the composer, and nothing is drafted" });
        continue;
      }
      const [who] = await db.select({ email: personTable.email, fullName: personTable.fullName }).from(personTable).where(eq(personTable.id, member.personId));
      const text = await request.compose(
        { personId: member.personId, ...(who?.email ? { email: who.email } : {}), ...(who?.fullName ? { fullName: who.fullName } : {}) },
        { channel: t.channel, step: t.step, ...(t.subject ? { subject: t.subject } : {}), body: t.body },
      );
      if (request.dryRun) {
        report.drafted.push({ personId: member.personId, outcome: "would_propose" });
        continue;
      }
      const proposed = await propose(
        db,
        fingerprints,
        {
          experimentId: request.experimentId,
          personId: member.personId,
          step: t.step,
          templateId: t.id,
          ...(text.subject !== undefined ? { renderedSubject: text.subject } : {}),
          renderedBody: text.body,
        },
        { actor: request.actor, runId: open.id },
        request.gate,
      );
      if (!proposed.ok) report.skipped.push({ member: { personId: member.personId }, reason: proposed.refused });
      else report.drafted.push({ personId: member.personId, draftId: proposed.draft.id, outcome: proposed.outcome });
    }
    await open.finish({ status: "succeeded" });
  } catch (thrown) {
    await open.finish({ status: "failed", error: (thrown as Error).message.slice(0, 500) }).catch(() => {});
    throw thrown;
  }
  return report;
}
