/**
 * gtm/runtime — the enrolment path (decision 0019).
 *
 * Candidates from the target list, the people at each from enrichment, a
 * protection check against the target list's protected route, and an
 * enrolment through the sequencer for the channel asked for. Every step runs
 * inside one recorded run.
 *
 * Protection is the first thing this file does and the reason it is shaped
 * the way it is. It fails closed (0004, doctrine 6): if the protected set
 * cannot be read to its last page, is older than the caller allows, says
 * when it was computed in a form that is not a time, or holds an account
 * with nothing to recognise it by, nobody is enrolled and the run says why.
 * A stale answer is an inability to know, not a green light. The kernel
 * decides what "stale" is — the caller passes the limit — and the adapter
 * only reports when its data is from.
 *
 * Matching protects wide. A candidate is protected if its domain, or its
 * identifier in the target list's own source, is a protected account's; a
 * person is protected if their company is, or if any address they have is
 * on a protected domain. Wrongly skipping someone is recoverable; wrongly
 * contacting them is not.
 *
 * Every candidate not enrolled is skipped for one stated reason, and the
 * reasons are kept apart: protected, capacity, duplicate, unreachable. A
 * report that only counted "not enrolled" would hide the one that matters.
 *
 * The registry (decision 0026) is read before the provider and written before
 * the provider is called. A person the registry has enrolled in the sequence
 * is a duplicate without asking anyone. Otherwise a `pending` row is written,
 * then the provider is called with the key on record, then the row is
 * settled — `enrolled`, or `refused` with what the provider said. A run that
 * dies in between leaves the row `pending`, and the next run asks the
 * provider: enrolled there means confirmed here, not enrolled twice. Every
 * skip is kept with its reason, for a dry run too; a dry run writes its run
 * and its skips, and nothing else — no registry row, no person, no company.
 */

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityVocabulary } from "@werunfoundry/core/identity";
import { normalizeIdentity } from "@werunfoundry/core/identity";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, OpenRun, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import type { Enrichment } from "@werunfoundry/relations/contracts/enrichment";
import { findPerson, recordCompany, recordPerson } from "@werunfoundry/relations/runtime/record";

import type { EnrolmentState, SenderRef, Sequencer } from "../contracts/sequencer.js";
import { remainingOf } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetCompany, TargetList, TargetQuery } from "../contracts/target-list.js";
import { enrolment, enrolmentSkip } from "../db/schema.js";

/** The contract names this path asks the registry for. The template binds them under these names. */
export const CONTRACTS = { targetList: "target_list", enrichment: "enrichment", sequencer: "sequencer" } as const;

export type SkipReason = "protected" | "capacity" | "duplicate" | "unreachable";

export interface EnrolRequest {
  sequenceKey: string;
  channel: string;
  /** The candidate query, passed to the target list untouched. */
  query?: TargetQuery;
  peoplePerCompany?: number;
  /**
   * How old the protected set may be, in minutes. Older is treated as
   * unknown, and unknown stops the run. Required: there is no default age at
   * which protection is good enough.
   */
  protectedMaxAgeMinutes: number;
  /**
   * The senders whose capacity bounds this run, on `channel`. Without them
   * capacity is not checked, and the report says so; it is never assumed.
   */
  senders?: SenderRef[];
  dryRun: boolean;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
}

export interface Enrolled {
  person: Identity;
  company: TargetCompany;
  state: EnrolmentState;
  pending?: string[];
}

export interface Skipped {
  reason: SkipReason;
  /** The person, or absent when a whole company was skipped. */
  person?: Identity;
  company: TargetCompany;
  detail: string;
}

export interface EnrolReport {
  runId: string;
  dryRun: boolean;
  /** "succeeded", "partial" (stopped mid-way), or "failed" (stopped before enrolling anyone). */
  status: "succeeded" | "partial" | "failed";
  /** Why the run stopped, when it did. */
  stoppedBy?: string;
  protectedAccounts: number;
  enrolled: Enrolled[];
  /**
   * People a previous run wrote to the registry and died before confirming,
   * found enrolled at the provider and confirmed now — not enrolled again.
   */
  reconciled: Enrolled[];
  skipped: Skipped[];
  /** Whether capacity bounded the run, or why not. */
  capacity: { checked: true; budget: number } | { checked: false; why: string };
  /**
   * Whether the run row was closed with this outcome. False means the
   * database refused the last write: the row still reads "running", and this
   * report is the only record of what happened.
   */
  recorded: boolean;
}

export interface EnrolDeps {
  db: Database;
  registry: Registry;
  identity: IdentityVocabulary;
  now?: () => Date;
}

/** A refusal to go on, carrying the sentence the run records. */
class Stop extends Error {}

const domainOf = (value: string) => value.trim().toLowerCase().replace(/^@/, "").replace(/^www\./, "");

/**
 * The same person in the same sequence on the same channel always gets the
 * same key, so a replay is recognised by the provider as the same enrolment.
 */
function idempotencyKey(person: Identity, sequenceKey: string, channel: string): string {
  const keys = person.keys.map((k) => `${k.kind}:${k.network ?? ""}:${k.value}`).sort();
  return createHash("sha256").update([sequenceKey, channel, ...keys].join("\n")).digest("hex").slice(0, 32);
}

export async function enrol(deps: EnrolDeps, request: EnrolRequest): Promise<EnrolReport> {
  const now = deps.now ?? (() => new Date());
  const targets = deps.registry.get(CONTRACTS.targetList) as TargetList | undefined;
  const enrichment = deps.registry.get(CONTRACTS.enrichment) as Enrichment | undefined;
  const sequencer = deps.registry.forChannel<Sequencer>(CONTRACTS.sequencer, request.channel);
  // Configuration, checked before a run is opened: a run that could not have
  // done anything is not a run.
  if (!targets) throw new Error(`no adapter is bound to "${CONTRACTS.targetList}"`);
  if (!enrichment) throw new Error(`no adapter is bound to "${CONTRACTS.enrichment}"`);
  if (!sequencer) throw new Error(`no "${CONTRACTS.sequencer}" adapter takes the channel "${request.channel}"`);
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");

  const open: OpenRun = await openRun(deps.db, {
    processKey: `gtm.enrol.${request.sequenceKey}`,
    trigger: request.trigger,
    actor: request.actor,
    dryRun: request.dryRun,
  });
  const ctx: CallContext = open.context;
  const report: EnrolReport = {
    runId: open.id,
    dryRun: request.dryRun,
    status: "succeeded",
    protectedAccounts: 0,
    enrolled: [],
    reconciled: [],
    skipped: [],
    capacity: { checked: false, why: "no sender was given" },
    recorded: false,
  };

  /**
   * A skip is reported and kept (decision 0026), dry run or not: it is an
   * observation of this run, and touches nothing the registry answers from.
   */
  const skip = async (s: Skipped) => {
    report.skipped.push(s);
    const subject = s.person
      ? `person:${idempotencyKey(s.person, request.sequenceKey, request.channel)}`
      : `company:${s.company.domain ?? s.company.externalId ?? s.company.name ?? JSON.stringify(s.company)}`;
    await deps.db
      .insert(enrolmentSkip)
      .values({
        runId: open.id,
        sequenceKey: request.sequenceKey,
        channel: request.channel,
        reason: s.reason,
        detail: s.detail.slice(0, 500),
        ...(s.person ? { person: s.person } : {}),
        company: { ...(s.company.domain ? { domain: s.company.domain } : {}), ...(s.company.externalId ? { externalId: s.company.externalId } : {}), ...(s.company.name ? { name: s.company.name } : {}) },
        subject,
      })
      .onConflictDoNothing({ target: [enrolmentSkip.runId, enrolmentSkip.subject] });
  };

  const registryRow = async (personId: string) =>
    (
      await deps.db
        .select({ id: enrolment.id, state: enrolment.state, idempotencyKey: enrolment.idempotencyKey })
        .from(enrolment)
        .where(and(eq(enrolment.personId, personId), eq(enrolment.sequenceKey, request.sequenceKey)))
    )[0];

  /** Moves a registry row, attributed to this run. */
  const settleRow = (id: string, change: { state: "pending" | "enrolled" | "refused"; enrolledAt?: Date; refusal?: string | null }) =>
    deps.db
      .update(enrolment)
      .set({
        ...change,
        actorType: request.actor.type,
        actorId: request.actor.id ?? null,
        runId: open.id,
        updatedAt: now(),
      })
      .where(eq(enrolment.id, id));

  try {
    /* 1. Protection, before anything else ------------------------------ */

    const fresh = await targets.freshness("protected", ctx);
    if (!fresh.ok) throw new Stop(`protection unavailable: the protected set's age could not be read (${fresh.error.code}: ${fresh.error.message})`);
    const asOf = Date.parse(fresh.value.asOf);
    if (Number.isNaN(asOf)) throw new Stop(`protection unavailable: the protected set says it is from "${fresh.value.asOf}", which is not a time`);
    const ageMinutes = (now().getTime() - asOf) / 60_000;
    if (ageMinutes > request.protectedMaxAgeMinutes) {
      throw new Stop(
        `protection unavailable: the protected set is ${Math.round(ageMinutes)} minutes old, older than the ${request.protectedMaxAgeMinutes} allowed`,
      );
    }

    const protectedDomains = new Set<string>();
    const protectedIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await targets.protectedAccounts({ ...(cursor ? { cursor } : {}) }, ctx);
      if (!page.ok) throw new Stop(`protection unavailable: the protected set could not be read to its last page (${page.error.code}: ${page.error.message})`);
      for (const account of page.value.items as ProtectedAccount[]) {
        if (!account.domain && !account.externalId) {
          throw new Stop("protection unavailable: a protected account has neither a domain nor an identifier, so nothing could be matched against it");
        }
        if (account.domain) protectedDomains.add(domainOf(account.domain));
        if (account.externalId) protectedIds.add(account.externalId);
        report.protectedAccounts++;
      }
      cursor = page.value.nextCursor;
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new Stop("protection unavailable: the protected set's pages loop");
        seenCursors.add(cursor);
      }
    } while (cursor !== undefined);

    const companyProtected = (c: TargetCompany) =>
      (c.domain !== undefined && protectedDomains.has(domainOf(c.domain))) ||
      (c.externalId !== undefined && protectedIds.has(c.externalId));
    const personProtected = (p: Identity) =>
      p.keys.some(
        (k) =>
          (k.kind === "email" && protectedDomains.has(domainOf(k.value.split("@")[1] ?? ""))) ||
          (k.kind === "domain" && protectedDomains.has(domainOf(k.value))),
      );

    /* 2. Capacity, known before the first enrolment, or not checked ---- */

    let budget = Number.POSITIVE_INFINITY;
    if (request.senders && request.senders.length > 0) {
      budget = 0;
      for (const sender of request.senders) {
        const c = await sequencer.capacity({ sender, channel: request.channel }, ctx);
        if (!c.ok) throw new Stop(`capacity unknown for ${sender.label ?? sender.externalId}: ${c.error.code}: ${c.error.message}`);
        // The tightest of the sender's limits (0020). A limit that does not
        // say what is left has not said zero, and is not ignored either.
        const left = remainingOf(c.value);
        if ("unknown" in left) throw new Stop(`capacity unknown for ${sender.label ?? sender.externalId}: ${left.unknown}`);
        budget += left.remaining;
      }
      report.capacity = { checked: true, budget };
    }

    /* 3. Candidates, people, enrolment ---------------------------------- */

    const candidates = await targets.candidates(request.query ?? {}, ctx);
    if (!candidates.ok) throw new Stop(`candidates unavailable: ${candidates.error.code}: ${candidates.error.message}`);

    const seenPeople = new Set<string>();
    for (const company of candidates.value.items) {
      if (companyProtected(company)) {
        await skip({ reason: "protected", company, detail: "the account is protected" });
        continue;
      }
      if (!company.domain) {
        await skip({ reason: "unreachable", company, detail: "no domain to find its people by" });
        continue;
      }
      const people = await enrichment.peopleAt(
        { company: { subject: "company", keys: [{ kind: "domain", value: company.domain }] }, limit: request.peoplePerCompany ?? 5 },
        ctx,
      );
      if (!people.ok) {
        await skip({ reason: "unreachable", company, detail: `its people could not be looked up: ${people.error.code}` });
        continue;
      }

      /** The company's row, recorded once per run, the first time someone at it is about to be enrolled. */
      let companyRow: { id: string } | { conflict: string } | undefined;
      const recordedCompany = async () =>
        (companyRow ??= await recordCompany(
          deps.db,
          company.identity ?? { subject: "company", keys: [{ kind: "domain", value: company.domain! }] },
          company.name ? { name: company.name } : {},
        ));

      for (const found of people.value.items.slice(0, request.peoplePerCompany ?? 5)) {
        const person = normalizeIdentity(found.identity, deps.identity);
        const computed = idempotencyKey(person, request.sequenceKey, request.channel);
        if (personProtected(person)) {
          await skip({ reason: "protected", person, company, detail: "an address is on a protected domain" });
          continue;
        }
        if (seenPeople.has(computed)) {
          await skip({ reason: "duplicate", person, company, detail: "already met in this run" });
          continue;
        }
        seenPeople.add(computed);

        // The registry first: what this engine already did for this person in
        // this sequence. Reads only, so a dry run asks it too.
        const known = await findPerson(deps.db, person);
        if ("conflict" in known) {
          await skip({ reason: "unreachable", person, company, detail: `the registry cannot tell who this is: ${known.conflict}` });
          continue;
        }
        let row = "id" in known ? await registryRow(known.id) : undefined;
        if (row?.state === "enrolled") {
          await skip({ reason: "duplicate", person, company, detail: "already enrolled in this sequence, by the registry" });
          continue;
        }
        // A replay repeats the key the provider was given, whatever the
        // person's keys have become since.
        const key = row?.idempotencyKey ?? computed;

        const current = await sequencer.status({ person, sequenceKey: request.sequenceKey }, ctx);
        if (!current.ok) {
          await skip({ reason: "unreachable", person, company, detail: `status unreadable: ${current.error.code}` });
          continue;
        }
        if (row?.state === "pending" && current.value.state !== "unknown") {
          // A run died after writing the registry: the enrolment landed, and
          // is confirmed rather than made twice. It consumed its capacity then.
          if (!request.dryRun) await settleRow(row.id, { state: "enrolled", enrolledAt: now() });
          report.reconciled.push({ person, company, state: current.value.state });
          continue;
        }
        if (current.value.state !== "unknown") {
          await skip({ reason: "duplicate", person, company, detail: `already in the sequence (${current.value.state})` });
          continue;
        }
        if (budget <= 0) {
          await skip({ reason: "capacity", person, company, detail: "no capacity left on the given senders" });
          continue;
        }

        // Written before the provider is called, so that a run dying in
        // between leaves something the next one can reconcile.
        if (!request.dryRun) {
          const companyId = await recordedCompany();
          if ("conflict" in companyId) {
            await skip({ reason: "unreachable", person, company, detail: `the recorded companies disagree about this one: ${companyId.conflict}` });
            continue;
          }
          const recorded = await recordPerson(deps.db, person, {
            ...(found.display?.fullName ? { fullName: found.display.fullName } : {}),
            companyId: companyId.id,
          });
          if ("conflict" in recorded) {
            await skip({ reason: "unreachable", person, company, detail: `the registry cannot tell who this is: ${recorded.conflict}` });
            continue;
          }
          if (row) {
            await settleRow(row.id, { state: "pending", refusal: null });
          } else {
            await deps.db
              .insert(enrolment)
              .values({
                personId: recorded.id,
                companyId: companyId.id,
                sequenceKey: request.sequenceKey,
                channel: request.channel,
                idempotencyKey: key,
                provider: sequencer.provider,
                actorType: request.actor.type,
                ...(request.actor.id ? { actorId: request.actor.id } : {}),
                runId: open.id,
              })
              .onConflictDoNothing({ target: [enrolment.personId, enrolment.sequenceKey] });
            row = await registryRow(recorded.id);
            if (!row) throw new Error("an enrolment was written and cannot be read back");
            // Another run got there first and finished: not ours to make again.
            if (row.state === "enrolled") {
              await skip({ reason: "duplicate", person, company, detail: "enrolled by another run while this one ran" });
              continue;
            }
          }
        }

        const done = await sequencer.enrol(
          {
            idempotencyKey: row?.idempotencyKey ?? key,
            sequenceKey: request.sequenceKey,
            channel: request.channel,
            person,
            ...(found.display?.fullName ? { display: { fullName: found.display.fullName } } : {}),
            attribution: { runId: open.id },
          },
          ctx,
        );
        if (!done.ok) {
          const e = done.error;
          if (e.code === "conflict" || e.code === "invalid" || e.code === "not_found") {
            if (row && !request.dryRun) await settleRow(row.id, { state: "refused", refusal: `${e.code}: ${e.message}`.slice(0, 500) });
            await skip({ reason: e.code === "conflict" ? "duplicate" : "unreachable", person, company, detail: e.message });
            continue;
          }
          // Anything else — the provider is down, rate-limited, refused the
          // key — stops the run where it is, the registry row left pending:
          // the next run asks the provider whether it landed.
          throw new Stop(`enrolment interrupted: ${e.code}: ${e.message}`);
        }
        if (row && !request.dryRun) await settleRow(row.id, { state: "enrolled", enrolledAt: now() });
        budget -= 1;
        report.enrolled.push({
          person,
          company,
          state: done.value.state,
          ...(done.value.pending ? { pending: done.value.pending } : {}),
        });
      }
    }
  } catch (thrown) {
    if (!(thrown instanceof Stop)) {
      // A bug, not an outcome: record it if the database lets us, and let it
      // through either way — a failed close must not hide the cause.
      await open
        .finish({ status: "failed", error: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 500) })
        .catch(() => {});
      throw thrown;
    }
    report.stoppedBy = thrown.message;
    report.status = report.enrolled.length === 0 ? "failed" : "partial";
  }

  try {
    await open.finish(
      report.status === "succeeded" ? { status: "succeeded" } : { status: report.status, error: (report.stoppedBy ?? "").slice(0, 500) },
    );
    report.recorded = true;
  } catch (error) {
    report.stoppedBy = `${report.stoppedBy ? `${report.stoppedBy}; ` : ""}the run could not be closed: ${(error as Error).message.split("\n")[0]}`;
  }
  return report;
}
