/**
 * acquisition/runtime — the enrolment path (decision 0019).
 *
 * Candidates from the target list, the people at each from the people
 * source (0030), a protection check against the target list's protected
 * route, and an enrolment through the sequencer for the channel asked for. Every step runs
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
import { checkIdentity, hostOf, normalizeIdentity } from "@werunfoundry/core/identity";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, OpenRun, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { run as runTable } from "@werunfoundry/core/db/schema";
import type { FoundPerson, PeopleSource } from "@werunfoundry/relations/contracts/people-source";
import { person as personTable } from "@werunfoundry/relations/db/schema";
import { findPerson, recordCompany, recordPerson } from "@werunfoundry/relations/runtime/record";

import type { EnrolmentState, SenderRef, Sequencer } from "../contracts/sequencer.js";
import { remainingOf } from "../contracts/sequencer.js";
import type { TargetCompany, TargetList, TargetQuery } from "../contracts/target-list.js";
import { enrolment, enrolmentSkip, sourcingResult } from "../db/schema.js";
import { readAcknowledged } from "./acknowledge.js";
import type { Protection } from "./protection.js";
import { readProtection } from "./protection.js";

/** The contract names this path asks the registry for. The template binds them under these names. */
export const CONTRACTS = { targetList: "target_list", peopleSource: "people_source", sequencer: "sequencer" } as const;

export type SkipReason = "protected" | "unreadable_key" | "opted_out" | "capacity" | "duplicate" | "unreachable";

export interface EnrolRequest {
  sequenceKey: string;
  /**
   * Enrol the people this live sourcing run kept (0031), with the keys
   * their completion attested, instead of finding people through the people
   * source. Nobody that run did not keep is considered.
   */
  fromSourcingRun?: string;
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
  /** Distinct protected accounts (decision 0033); `protectedRows` counts the source's rows. */
  protectedAccounts: number;
  protectedRows: number;
  /**
   * For each protected entry that matched, how many distinct candidates it
   * excluded in this run (decision 0044): the guard on the ancestor walk. An
   * entry excluding far more than its share shows here first.
   */
  protectionHits: { entry: string; candidates: number }[];
  /**
   * What protection matched on, and the acknowledged customers it could not
   * protect (0034). Absent when the run stopped before protection was read.
   */
  protection?: Pick<Protection, "surface" | "unkeyedRowsOfCoveredCustomers" | "uncovered">;
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

/**
 * A domain as protection compares it: the host it names (decision 0028). The
 * target list's two routes come from different sources, and one spelling a
 * company as `http://Example.com` must not let it past the other's `example.com`.
 */
const domainOf = hostOf;

/**
 * The same person in the same sequence on the same channel always gets the
 * same key, so a replay is recognised by the provider as the same enrolment.
 */
function idempotencyKey(person: Identity, sequenceKey: string, channel: string): string {
  const keys = person.keys.map((k) => `${k.kind}:${k.network ?? ""}:${k.value}`).sort();
  return createHash("sha256").update([sequenceKey, channel, ...keys].join("\n")).digest("hex").slice(0, 32);
}

/**
 * The people a sourcing run kept, grouped by company, as that run recorded
 * them: the completed identity and the person row it was recorded as.
 *
 * Only a live run that finished — succeeded, or partial after keeping
 * someone — can be enrolled from. A dry run kept nobody on record, a failed
 * one stopped before deciding, and a run of another process is not a
 * sourcing run. Each is refused with the reason, before anything is opened.
 */
async function keptBy(deps: EnrolDeps, runId: string): Promise<{ company: TargetCompany; people: FoundPerson[] }[]> {
  const [source] = await deps.db
    .select({ processKey: runTable.processKey, dryRun: runTable.dryRun, status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!source) throw new Error(`no run ${runId} is on record`);
  if (source.processKey !== "acquisition.source") throw new Error(`run ${runId} is a run of ${source.processKey}, not a sourcing run`);
  if (source.dryRun) throw new Error(`run ${runId} was a dry run: it kept nobody on record`);
  if (source.status !== "succeeded" && source.status !== "partial") throw new Error(`run ${runId} ${source.status === "running" ? "is still running" : `ended as ${source.status}`}; only a finished sourcing run can be enrolled from`);

  const rows = await deps.db
    .select({ person: sourcingResult.person, company: sourcingResult.company, fullName: personTable.fullName })
    .from(sourcingResult)
    .innerJoin(personTable, eq(personTable.id, sourcingResult.personId))
    .where(and(eq(sourcingResult.runId, runId), eq(sourcingResult.outcome, "kept")));
  const groups = new Map<string, { company: TargetCompany; people: FoundPerson[] }>();
  for (const row of rows) {
    const company = { ...(row.company as Omit<TargetCompany, "attributes">), attributes: {} } as TargetCompany;
    const key = JSON.stringify(row.company);
    const group = groups.get(key) ?? { company, people: [] };
    group.people.push({ identity: row.person as Identity, ...(row.fullName ? { display: { fullName: row.fullName } } : {}) });
    groups.set(key, group);
  }
  return [...groups.values()];
}

export async function enrol(deps: EnrolDeps, request: EnrolRequest): Promise<EnrolReport> {
  const now = deps.now ?? (() => new Date());
  const targets = deps.registry.get(CONTRACTS.targetList) as TargetList | undefined;
  const people = deps.registry.get(CONTRACTS.peopleSource) as PeopleSource | undefined;
  const sequencer = deps.registry.forChannel<Sequencer>(CONTRACTS.sequencer, request.channel);
  // Configuration, checked before a run is opened: a run that could not have
  // done anything is not a run.
  if (!targets) throw new Error(`no adapter is bound to "${CONTRACTS.targetList}"`);
  if (!people && !request.fromSourcingRun) throw new Error(`no adapter is bound to "${CONTRACTS.peopleSource}"`);
  if (!sequencer) throw new Error(`no "${CONTRACTS.sequencer}" adapter takes the channel "${request.channel}"`);
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");

  // A sourcing run is read before this run is opened: a run that names one
  // that cannot be enrolled from could not have done anything.
  const fromRun = request.fromSourcingRun ? await keptBy(deps, request.fromSourcingRun) : undefined;

  const open: OpenRun = await openRun(deps.db, {
    processKey: `acquisition.enrol.${request.sequenceKey}`,
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
    protectionHits: [],
    protectedRows: 0,
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

  /** Read once protection is: what each protected entry excluded (0044). */
  let hitsOf: Protection["hits"] | undefined;
  try {
    /* 1. Protection, before anything else ------------------------------ */

    // The customers a person acknowledged as uncovered (0034): read here,
    // never written by a run.
    const acknowledged = await readAcknowledged(deps.db);
    const read = await readProtection(targets, { maxAgeMinutes: request.protectedMaxAgeMinutes, now: now(), acknowledged }, ctx);
    if (!read.ok) throw new Stop(read.stop);
    const protection = read.protection;
    hitsOf = protection.hits;
    report.protectedAccounts = protection.accounts;
    report.protectedRows = protection.rows;
    report.protection = { surface: protection.surface, unkeyedRowsOfCoveredCustomers: protection.unkeyedRowsOfCoveredCustomers, uncovered: protection.uncovered };
    // Fail closed (0044): protected, or a domain that is not a host — each said as itself.
    const companySkip = (company: TargetCompany): { reason: SkipReason; detail: string } | undefined => {
      const verdict = protection.verdict(company);
      if (verdict === "protected") return { reason: "protected", detail: "the account is protected" };
      if (verdict === "unreadable_key") return { reason: "unreadable_key", detail: `its domain is not a host that can be read: "${company.domain}"` };
      return undefined;
    };
    const personProtected = protection.person;

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

    /* 3. Who to consider: the target list's people, or a sourcing run's -- */

    /**
     * Each company, and the people at it to consider. From the target list
     * and the people source, company by company, as before; or from the
     * people a sourcing run kept (0031), with the keys their completion
     * attested — never sourced again here, and never anyone that run did not
     * keep. Either way, everyone goes through the same checks below:
     * protection is read fresh by this run, not trusted from the other one.
     */
    async function* considered(): AsyncGenerator<{ company: TargetCompany; host: string; people: FoundPerson[] }> {
      if (fromRun) {
        for (const group of fromRun) {
          const company = group.company;
          const refused = companySkip(company);
          if (refused) {
            await skip({ ...refused, company });
            continue;
          }
          yield { company, host: company.domain ? domainOf(company.domain) : "", people: group.people };
        }
        return;
      }
      const candidates = await targets!.candidates(request.query ?? {}, ctx);
      if (!candidates.ok) throw new Stop(`candidates unavailable: ${candidates.error.code}: ${candidates.error.message}`);
      for (const company of candidates.value.items) {
        const refused = companySkip(company);
        if (refused) {
          await skip({ ...refused, company });
          continue;
        }
        const host = company.domain ? domainOf(company.domain) : "";
        if (!host) {
          await skip({ reason: "unreachable", company, detail: "no domain to find its people by" });
          continue;
        }
        // The company as the target list attests it (decisions 0024, 0029): its
        // domain, and its id on a network when the source holds one. A
        // people source that only searches from an attested id gets one; a
        // key the vocabulary refuses is not passed on as if it were good.
        const companyIdentity = normalizeIdentity(
          {
            subject: "company",
            keys: [{ kind: "domain", value: host }, ...(company.identity?.keys.filter((k) => k.kind !== "domain") ?? [])],
          },
          deps.identity,
        );
        const malformed = checkIdentity(companyIdentity, deps.identity).filter((i) => i.severity === "error");
        if (malformed.length > 0) {
          await skip({ reason: "unreachable", company, detail: `the target list's keys for it are not valid: ${malformed.map((i) => i.message).join("; ")}` });
          continue;
        }
        const found = await people!.peopleAt({ company: companyIdentity, limit: request.peoplePerCompany ?? 5 }, ctx);
        if (!found.ok) {
          await skip({ reason: "unreachable", company, detail: `its people could not be looked up: ${found.error.code}` });
          continue;
        }
        yield { company, host, people: found.value.items.slice(0, request.peoplePerCompany ?? 5) };
      }
    }

    /* 4. Each person: the checks, the registry, the enrolment ------------ */

    const seenPeople = new Set<string>();
    for await (const { company, host, people: atCompany } of considered()) {
      /** The company's row, recorded once per run, the first time someone at it is about to be enrolled. */
      let companyRow: { id: string } | { conflict: string } | undefined;
      const recordedCompany = async () =>
        (companyRow ??= await recordCompany(
          deps.db,
          company.identity ?? { subject: "company", keys: [{ kind: "domain", value: host }] },
          company.name ? { name: company.name } : {},
        ));

      for (const one of atCompany) {
        const person = normalizeIdentity(one.identity, deps.identity);
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
        // The global opt-out, read by every path that contacts anyone: a
        // person who opted out is not enrollable by any route.
        if ("id" in known) {
          const [recorded] = await deps.db.select({ optedOutAt: personTable.optedOutAt }).from(personTable).where(eq(personTable.id, known.id));
          if (recorded?.optedOutAt) {
            await skip({ reason: "opted_out", person, company, detail: "opted out" });
            continue;
          }
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
            ...(one.display?.fullName ? { fullName: one.display.fullName } : {}),
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
            ...(one.display?.fullName ? { display: { fullName: one.display.fullName } } : {}),
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

  report.protectionHits = hitsOf?.() ?? [];

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
