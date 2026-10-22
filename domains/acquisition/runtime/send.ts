/**
 * acquisition/runtime — the sending path, from a frozen list to a recorded
 * touch (decision 0050), with its hand-over stubbed.
 *
 * Two runs, with a person between them, because a reviewed lane waits on a
 * human approval and an approval is not a step of a run (0027):
 *
 * 1. `draftFromList` — read the list (sealed; nothing about consent or
 *    protection is read from it: a list is a selection, never a permission,
 *    0037), compose each person's text with the caller's composer, and
 *    propose the draft, which applies the opt-out and the lane.
 * 2. `sendFromList` — for the experiment's approved or queued drafts whose
 *    person is on the list: read protection, fresh and failing closed, as
 *    enrolment does; write the message through its gate (consent, cadence,
 *    lane — 0038); queue the draft; hand it over; then record the touch and
 *    settle the draft in one transaction.
 *
 * **Nothing here reaches a provider.** The hand-over is the caller's, and this
 * package ships none: no command calls this path, and its tests and
 * try-instance each bring a stub. Sending for real is a later decision.
 *
 * The message is written before the hand-over and the touch after it (0038).
 * A message with no touch is a hand-over nobody confirmed; it counts against
 * the cap until its touch is recorded, and a replay resumes it: the same key
 * is the same message, the hand-over is idempotent on it, and the touch is
 * held once by its message.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import type { CallContext, CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import type { Fingerprinter } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { company as companyTable, person as personTable } from "@werunfoundry/relations/db/schema";
import { readList } from "@werunfoundry/relations/runtime/list";
import { writeMessage } from "@werunfoundry/relations/runtime/message";
import { recordTouch } from "@werunfoundry/relations/runtime/record";

import type { TargetCompany, TargetList } from "../contracts/target-list.js";
import { draft, template } from "../db/schema.js";
import { readAcknowledged } from "./acknowledge.js";
import type { Gate } from "./draft.js";
import { drop, messageKey, propose, queue, settle } from "./draft.js";

export { messageKey };
import { CONTRACTS } from "./enrol.js";
import { readProtection } from "./protection.js";

/**
 * Where the sequencer will be (decision 0050): one message, handed over to be
 * sent. Idempotent on the key — handing the same message over twice is one
 * send. Answers with the provider's own id for the send, which the touch
 * keeps as its `provider_event_id`. No implementation ships with the kernel.
 */
export interface HandOver extends Contract {
  handOver(
    message: {
      idempotencyKey: string;
      channel: string;
      sender?: string;
      person: Identity;
      subject?: string;
      body: string;
      attribution: { runId: string; experimentId: string };
    },
    ctx: CallContext,
  ): Promise<CallResult<{ providerEventId: string; at: string }>>;
}

/** The text of one person's draft, from the template. The engine does not write copy (0027): the caller does. */
export type Compose = (
  person: { personId: string; email?: string; fullName?: string },
  template: { channel: string; step: number; subject?: string; body: string },
) => Promise<{ subject?: string; body: string }> | { subject?: string; body: string };


type Status = "succeeded" | "partial" | "failed";

/** A refusal to go on, carrying the sentence the run records. */
class Stop extends Error {}

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

/* Run 2 — from approved drafts to touches -------------------------------- */

export interface SendRequest {
  listKey: string;
  experimentId: string;
  /** Whether these sends were not asked for. No default (0038). */
  unsolicited: boolean;
  /** Required when unsolicited: at most `max` unsolicited contacts with a person in `withinDays`. */
  cap?: { max: number; withinDays: number };
  /** How old the protected set may be, in minutes. Required: no default age is good enough (0019). */
  protectedMaxAgeMinutes: number;
  /** For a draft the reactive lane approved: the window its license is read again in (0042). */
  reactiveWithinMinutes?: number;
  dryRun: boolean;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
}

export type SendOutcome =
  | { draftId: string; personId: string; outcome: "sent"; messageId: string; touchRecorded: boolean }
  | { draftId: string; personId: string; outcome: "would_send" }
  | { draftId: string; personId: string; outcome: "protected" | "refused" | "not_queued" | "failed" | "no_channel"; detail: string[] };

export interface SendReport {
  runId: string;
  dryRun: boolean;
  status: Status;
  stoppedBy?: string;
  /** One line per draft considered, in the order they were proposed. */
  drafts: SendOutcome[];
}

export interface SendDeps {
  db: Database;
  registry: Registry;
  handOver: HandOver;
  /** What the one reader recognises the register's entries with (0055): boot's. */
  fingerprints: Fingerprinter;
  now?: () => Date;
}

/** A recorded person, as the keys `relations` holds for them: an address, and a profile id on a network. */
function identityOf(row: { email: string | null; externalId: string | null }): Identity {
  const keys: Identity["keys"] = [];
  if (row.email) keys.push({ kind: "email", value: row.email });
  const at = row.externalId?.indexOf(":") ?? -1;
  if (row.externalId && at > 0) keys.push({ kind: "social_profile_id", network: row.externalId.slice(0, at), value: row.externalId.slice(at + 1) });
  return { subject: "person", keys };
}

/**
 * The company `relations` recorded for the person, as protection compares
 * one: its domain, and its id on a network. Not the target list's answer
 * about where they work now — nothing knows that (0050, *The missing
 * affiliation*).
 */
function companyOf(row: { domain: string | null; externalId: string | null; name: string | null }): TargetCompany {
  const keys: Identity["keys"] = [];
  if (row.domain) keys.push({ kind: "domain", value: row.domain });
  const at = row.externalId?.indexOf(":") ?? -1;
  if (row.externalId && at > 0) keys.push({ kind: "social_company_id", network: row.externalId.slice(0, at), value: row.externalId.slice(at + 1) });
  return { ...(row.domain ? { domain: row.domain } : {}), ...(row.name ? { name: row.name } : {}), identity: { subject: "company", keys }, attributes: {} } as TargetCompany;
}

export async function sendFromList(deps: SendDeps, request: SendRequest): Promise<SendReport> {
  const db = deps.db;
  const now = deps.now ?? (() => new Date());
  const targets = deps.registry.get(CONTRACTS.targetList) as TargetList | undefined;
  if (!targets) throw new Error(`no adapter is bound to "${CONTRACTS.targetList}": protection cannot be read`);
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");
  const list = await sealedList(db, request.listKey);
  const onList = list.members.flatMap((m) => (m.personId ? [m.personId] : []));

  const open = await openRun(db, { processKey: "acquisition.send", trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const ctx = open.context;
  const by = { actor: request.actor, runId: open.id };
  const system = { actor: { type: "system" as const }, runId: open.id };
  const report: SendReport = { runId: open.id, dryRun: request.dryRun, status: "succeeded", drafts: [] };

  try {
    /* 4. Protection, before anything is written ---------------------------- */
    const read = await readProtection(targets, { maxAgeMinutes: request.protectedMaxAgeMinutes, now: now(), acknowledged: await readAcknowledged(db) }, ctx);
    if (!read.ok) throw new Stop(read.stop);
    const protection = read.protection;

    const pending =
      onList.length === 0
        ? []
        : await db
            .select({
              id: draft.id,
              personId: draft.personId,
              state: draft.state,
              renderedSubject: draft.renderedSubject,
              renderedBody: draft.renderedBody,
              sender: draft.sender,
              decidedBy: draft.decidedBy,
              channel: template.channel,
            })
            .from(draft)
            .leftJoin(template, eq(template.id, draft.templateId))
            .where(and(eq(draft.experimentId, request.experimentId), inArray(draft.state, ["approved", "queued"]), inArray(draft.personId, onList)))
            .orderBy(asc(draft.createdAt));

    for (const d of pending) {
      const [who] = await db
        .select({ email: personTable.email, externalId: personTable.externalId, domain: companyTable.domain, companyExternalId: companyTable.externalId, companyName: companyTable.name })
        .from(personTable)
        .leftJoin(companyTable, eq(companyTable.id, personTable.companyId))
        .where(eq(personTable.id, d.personId));
      const person = identityOf({ email: who?.email ?? null, externalId: who?.externalId ?? null });
      const line = { draftId: d.id, personId: d.personId };

      // A draft with no template has no channel to be sent on (0042).
      if (!d.channel || d.renderedBody === null) {
        report.drafts.push({ ...line, outcome: "no_channel", detail: ["the draft has no template, so no channel to be sent on"] });
        continue;
      }

      const verdict = who?.domain || who?.companyExternalId ? protection.verdict(companyOf({ domain: who.domain, externalId: who.companyExternalId, name: who.companyName })) : "clear";
      if (verdict !== "clear" || protection.person(person)) {
        const why = verdict === "unreadable_key" ? "the recorded company's domain is not a host that can be read" : "protected at sending";
        if (!request.dryRun) {
          if (d.state === "approved") await drop(db, d.id, { by: "system", reason: why }, system);
          else await settle(db, d.id, { state: "failed", reason: why }, system);
        }
        report.drafts.push({ ...line, outcome: "protected", detail: [why] });
        continue;
      }

      if (request.dryRun) {
        report.drafts.push({ ...line, outcome: "would_send" });
        continue;
      }

      /* 5. The message, through its gate ----------------------------------- */
      const written = await writeMessage(
        db,
        deps.fingerprints,
        {
          key: messageKey(d.id),
          personId: d.personId,
          channel: d.channel,
          ...(d.sender ? { sender: d.sender } : {}),
          ...(d.renderedSubject ? { subject: d.renderedSubject } : {}),
          body: d.renderedBody,
          unsolicited: request.unsolicited,
          ...(request.cap ? { cap: request.cap } : {}),
          experimentId: request.experimentId,
          ...(d.decidedBy ? { approvedBy: d.decidedBy } : {}),
          ...(request.reactiveWithinMinutes !== undefined ? { reactiveWithinMinutes: request.reactiveWithinMinutes } : {}),
          actor: request.actor,
          runId: open.id,
        },
        now(),
      );
      if (!written.ok) {
        // The gate decides whether now: the draft stays approved.
        report.drafts.push({ ...line, outcome: "refused", detail: written.refused });
        continue;
      }

      /* 6. Queued, by the draft's own gate ---------------------------------- */
      if (d.state === "approved") {
        const queued = await queue(db, deps.fingerprints, d.id, by);
        if (!queued.ok) {
          report.drafts.push({ ...line, outcome: "not_queued", detail: [queued.refused] });
          continue;
        }
      }

      /* 7. The hand-over: the seam --------------------------------------- */
      const handed = await deps.handOver.handOver(
        {
          idempotencyKey: messageKey(d.id),
          channel: d.channel,
          ...(d.sender ? { sender: d.sender } : {}),
          person,
          ...(d.renderedSubject ? { subject: d.renderedSubject } : {}),
          body: d.renderedBody,
          attribution: { runId: open.id, experimentId: request.experimentId },
        },
        ctx,
      );
      if (!handed.ok) {
        const e = handed.error;
        // Retryable: stop where we are; the draft stays queued, and the next run resumes it.
        if (e.retryable) throw new Stop(`hand-over interrupted: ${e.code}: ${e.message}`);
        const reason = `${e.code}: ${e.message}`.slice(0, 500);
        await settle(db, d.id, { state: "failed", reason }, by);
        report.drafts.push({ ...line, outcome: "failed", detail: [reason] });
        continue;
      }

      /* 8. The touch and the draft, together -------------------------------- */
      const touchRecorded = await db.transaction(async (tx) => {
        const t = await recordTouch(tx, {
          personId: d.personId,
          channel: d.channel!,
          direction: "outbound",
          unsolicited: request.unsolicited,
          provider: deps.handOver.provider,
          providerEventId: handed.value.providerEventId,
          occurredAt: new Date(handed.value.at),
          ...(d.sender ? { sender: d.sender } : {}),
          experimentId: request.experimentId,
          messageId: written.messageId,
          actor: request.actor,
          runId: open.id,
        });
        const settled = await settle(tx, d.id, { state: "sent" }, by);
        if (!settled.ok) throw new Error(`the draft could not be settled: ${settled.refused}`);
        return t.recorded;
      });
      report.drafts.push({ ...line, outcome: "sent", messageId: written.messageId, touchRecorded });
    }
  } catch (thrown) {
    if (!(thrown instanceof Stop)) {
      await open.finish({ status: "failed", error: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 500) }).catch(() => {});
      throw thrown;
    }
    report.stoppedBy = thrown.message;
    report.status = report.drafts.some((d) => d.outcome === "sent") ? "partial" : "failed";
  }
  await open.finish(report.status === "succeeded" ? { status: "succeeded" } : { status: report.status, error: (report.stoppedBy ?? "").slice(0, 500) });
  return report;
}
