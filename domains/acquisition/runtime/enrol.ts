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

import { and, eq, inArray, ne } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityVocabulary } from "@werunfoundry/core/identity";
import { checkIdentity, hostOf, normalizeIdentity } from "@werunfoundry/core/identity";
import type { Fingerprinter } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, OpenRun, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { experiment as experimentTable, run as runTable } from "@werunfoundry/core/db/schema";
import type { FoundPerson, PeopleSource } from "@werunfoundry/relations/contracts/people-source";
import { company as companyTable, person as personTable, touch as touchTable } from "@werunfoundry/relations/db/schema";
import { readList } from "@werunfoundry/relations/runtime/list";
import { writeMessage } from "@werunfoundry/relations/runtime/message";
import { readObjection, recordCompany, recordPerson } from "@werunfoundry/relations/runtime/record";

import type { EnrolmentState, SenderRef, Sequencer } from "../contracts/sequencer.js";
import { readDeclaration, remainingOf } from "../contracts/sequencer.js";
import type { TargetCompany, TargetList, TargetQuery } from "../contracts/target-list.js";
import { draft, enrolment, enrolmentSkip, sourcingResult, template } from "../db/schema.js";
import { readAcknowledged } from "./acknowledge.js";
import { messageKey } from "./draft.js";
import type { ProtectedStop } from "./protected.js";
import { stopProtected } from "./protected.js";
import type { Protection } from "./protection.js";
import { readProtection } from "./protection.js";
import type { Cap } from "./cap.js";
import { judgeAhead, planTimes } from "./cap.js";
import type { PlannedStep, StepRender } from "./steps.js";
import { compareSteps } from "./steps.js";

/** The contract names this path asks the registry for. The template binds them under these names. */
export const CONTRACTS = { targetList: "target_list", peopleSource: "people_source", sequencer: "sequencer" } as const;

export type SkipReason = "protected" | "unreadable_key" | "opted_out" | "capacity" | "duplicate" | "unreachable" | "suspended" | "not_drafted" | "refused" | "capped";

export interface EnrolRequest {
  sequenceKey: string;
  /**
   * Enrol the people this live sourcing run kept (0031), with the keys
   * their completion attested, instead of finding people through the people
   * source. Nobody that run did not keep is considered.
   */
  fromSourcingRun?: string;
  /**
   * Decision 0064: enrol the people of this sealed list, each carrying the
   * messages the kernel wrote — one approved draft per step of the sequence,
   * of one variant of the experiment, each written through the message gate
   * (0038) before the provider is called, and handed to it as the variable
   * its step renders. The provider's steps are read and held against the
   * experiment's templates first: a plan it will not run is refused.
   *
   * Unsolicited, the cap is required, with no default (0038), and judged
   * ahead over the whole plan before anyone is reached (0064 §3), through a
   * sequencer that pulls what it sent (§6). Solicited, it is not capped,
   * and the report says so.
   */
  fromList?: { listKey: string; experimentId: string; unsolicited: boolean; cap?: Cap; reactiveWithinMinutes?: number };
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
  /**
   * What the run's start did to the enrolments already running at accounts
   * protection now excludes (decision 0057). Absent when the run stopped
   * before protection was read. Not 0004's promise kept: that holds only as
   * often as this or `kernel-stop-protected` runs (`PROMISE`).
   */
  protectedStop?: ProtectedStop;
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
   * From a list (0064): the cap judged ahead over each person's plan, or why
   * the enrolment is not capped — said whenever it is not.
   */
  cap?: { judged: true; max: number; withinDays: number } | { judged: false; why: string };
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
  /** What the one reader recognises the register's entries with (0055): boot's. */
  fingerprints: Fingerprinter;
  now?: () => Date;
}

/** A refusal to go on, carrying the sentence the run records. */
class Stop extends Error {}

/**
 * The bound sequencer cannot suspend one person, or does not say it can
 * (decision 0051). Thrown before a run is opened, like every other refusal
 * of configuration: nobody could be enrolled, so there is no run.
 */
export class CannotSuspend extends Error {}

/**
 * PROVISIONAL — removed when the guard decision 0055 brings lands, and not to
 * be extended to anything else. A live enrolment once an erasure has run,
 * while the passage that holds 0055's threshold is not built. The one reader
 * now finds an erased objector by the keys the erasure kept (0052, 0062), and
 * enrolment asks it; 0055 removes this guard with `clear`, never before.
 * Thrown before a run is opened, here and not only in `kernel-enrol`, so that
 * no other caller goes round it.
 */
export class ErasedWithoutRegister extends Error {}

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

/** A recorded person, as the keys `relations` holds for them: an address, and a profile id on a network. */
function recordedIdentity(row: { email: string | null; externalId: string | null }): Identity {
  const keys: Identity["keys"] = [];
  if (row.email) keys.push({ kind: "email", value: row.email });
  const at = row.externalId?.indexOf(":") ?? -1;
  if (row.externalId && at > 0) keys.push({ kind: "social_profile_id", network: row.externalId.slice(0, at), value: row.externalId.slice(at + 1) });
  return { subject: "person", keys };
}

/**
 * The company `relations` recorded for a person, as protection compares one:
 * its domain, and its id on a network. Not the target list's answer about
 * where they work now — nothing knows that (0050, *The missing affiliation*).
 */
function recordedCompany(row: { domain: string | null; externalId: string | null; name: string | null }): TargetCompany {
  const keys: Identity["keys"] = [];
  if (row.domain) keys.push({ kind: "domain", value: row.domain });
  const at = row.externalId?.indexOf(":") ?? -1;
  if (row.externalId && at > 0) keys.push({ kind: "social_company_id", network: row.externalId.slice(0, at), value: row.externalId.slice(at + 1) });
  return { ...(row.domain ? { domain: row.domain } : {}), ...(row.name ? { name: row.name } : {}), identity: { subject: "company", keys }, attributes: {} } as TargetCompany;
}

/**
 * The people of a sealed list, grouped by the company each is recorded at,
 * and the experiment's plan, variant by variant: its templates, step by step.
 * Read before the run is opened: a list or an experiment that cannot be
 * enrolled from could not have done anything.
 */
async function listed(deps: EnrolDeps, from: NonNullable<EnrolRequest["fromList"]>) {
  const list = await readList(deps.db, from.listKey.trim());
  if (!list) throw new Error(`no list ${from.listKey} is on record`);
  if (!list.sealedAt) throw new Error(`the list ${from.listKey} is not sealed: it is still being constituted`);
  const [exp] = await deps.db.select({ slug: experimentTable.slug }).from(experimentTable).where(eq(experimentTable.id, from.experimentId));
  if (!exp) throw new Error(`no experiment ${from.experimentId} is on record`);
  const templates = await deps.db
    .select({ variant: template.variant, step: template.step, channel: template.channel, delayDays: template.delayDays, subject: template.subject })
    .from(template)
    .where(eq(template.experimentId, from.experimentId));
  if (templates.length === 0) throw new Error(`the experiment ${from.experimentId} has no template: there is no message to carry`);
  const plans = new Map<string, PlannedStep[]>();
  for (const t of templates) plans.set(t.variant, [...(plans.get(t.variant) ?? []), { step: t.step, channel: t.channel, delayDays: t.delayDays, subject: t.subject !== null }]);

  const groups = new Map<string, { company: TargetCompany; companyId: string | null; people: (FoundPerson & { personId: string })[] }>();
  const companies: { companyId: string }[] = [];
  for (const member of list.members) {
    if (!member.personId) {
      companies.push({ companyId: member.companyId! });
      continue;
    }
    const [who] = await deps.db
      .select({ email: personTable.email, externalId: personTable.externalId, fullName: personTable.fullName, companyId: personTable.companyId, domain: companyTable.domain, companyExternalId: companyTable.externalId, companyName: companyTable.name })
      .from(personTable)
      .leftJoin(companyTable, eq(companyTable.id, personTable.companyId))
      .where(eq(personTable.id, member.personId));
    if (!who) continue;
    const key = who.companyId ?? `none:${member.personId}`;
    const group = groups.get(key) ?? { company: recordedCompany({ domain: who.domain, externalId: who.companyExternalId, name: who.companyName }), companyId: who.companyId, people: [] };
    group.people.push({ personId: member.personId, identity: recordedIdentity(who), ...(who.fullName ? { display: { fullName: who.fullName } } : {}) });
    groups.set(key, group);
  }
  return { experimentSlug: exp.slug, plans, groups: [...groups.values()], companies };
}

export async function enrol(deps: EnrolDeps, request: EnrolRequest): Promise<EnrolReport> {
  const now = deps.now ?? (() => new Date());
  const targets = deps.registry.get(CONTRACTS.targetList) as TargetList | undefined;
  const people = deps.registry.get(CONTRACTS.peopleSource) as PeopleSource | undefined;
  const sequencer = deps.registry.forChannel<Sequencer>(CONTRACTS.sequencer, request.channel);
  // Configuration, checked before a run is opened: a run that could not have
  // done anything is not a run.
  if (!targets) throw new Error(`no adapter is bound to "${CONTRACTS.targetList}"`);
  if (request.fromList && (request.fromSourcingRun || request.query)) throw new Error("an enrolment from a list takes its people from the list alone: no sourcing run, no query");
  if (!people && !request.fromSourcingRun && !request.fromList) throw new Error(`no adapter is bound to "${CONTRACTS.peopleSource}"`);
  if (!sequencer) throw new Error(`no "${CONTRACTS.sequencer}" adapter takes the channel "${request.channel}"`);
  // An enrolment nobody can stop until its sequence ends is protection that
  // lasts until the next step fires (0004, 0051). Dry runs too: a dry run
  // shows what the live run would do, and the live run would do nothing.
  const declared = readDeclaration(sequencer);
  if (!declared.suspends) throw new CannotSuspend(declared.refusal);
  // PROVISIONAL (above). The register would only ever hold people the kernel
  // erased, so the window opens with the first live erasure run; one deleted
  // by hand reopens it. Read by `run_process_started_at_idx`.
  if (!request.dryRun) {
    const erased = await deps.db
      .select({ id: runTable.id })
      .from(runTable)
      .where(and(eq(runTable.processKey, "relations.person.erase"), eq(runTable.dryRun, false)))
      .limit(1);
    if (erased.length > 0) {
      throw new ErasedWithoutRegister(
        "an erasure has run on this instance, and the passage that holds the threshold is not built (decision 0055): live enrolment stays refused until it is",
      );
    }
  }
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");
  if (request.fromList) {
    // 0064 §3: an unsolicited enrolment is capped ahead, over its whole
    // plan, or not made. The cap that exists judges the window behind.
    if (request.fromList.unsolicited) {
      const cap = request.fromList.cap;
      if (!cap || !Number.isInteger(cap.max) || cap.max < 0 || !(cap.withinDays > 0)) {
        throw new Error("an unsolicited enrolment needs a cap — a count and a window — and there is no default (decisions 0038, 0064 §3): nobody is enrolled");
      }
      // 0064 §6: a cap that cannot see what the sequencer sent on its own is
      // not one. Refused as 0051's first refusal is: before a run, dry too.
      // A pull declared served with no method behind it is refused above,
      // with the declaration (0054).
      if ((sequencer.declares?.pullTouches?.serves ?? "no") === "no") {
        const why = sequencer.declares?.pullTouches?.serves === "no" ? sequencer.declares.pullTouches.why : "it does not say";
        throw new Error(`the sequencer "${sequencer.provider}" does not pull what it sent (${why}), so an unsolicited enrolment through it cannot be capped (decision 0064 §6): nobody is enrolled`);
      }
    }
    // 0064 §5: the provider's steps are held against the templates.
    if (typeof sequencer.readSteps !== "function" || (sequencer.declares?.readSteps?.serves ?? "no") === "no") {
      throw new Error(`the sequencer "${sequencer.provider}" does not read a sequence's steps, and an enrolment that carries messages is held against them (decision 0064 §5): nobody is enrolled`);
    }
  }

  // A sourcing run is read before this run is opened: a run that names one
  // that cannot be enrolled from could not have done anything.
  const fromRun = request.fromSourcingRun ? await keptBy(deps, request.fromSourcingRun) : undefined;
  const fromList = request.fromList ? await listed(deps, request.fromList) : undefined;

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
    ...(request.fromList
      ? {
          cap: request.fromList.unsolicited
            ? { judged: true as const, max: request.fromList.cap!.max, withinDays: request.fromList.cap!.withinDays }
            : { judged: false as const, why: "solicited: the person asked for it, on the reactive lane (decision 0042), and a solicited enrolment is not capped (decision 0064 §6)" },
        }
      : {}),
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

  /**
   * What already reaches a person, for the cap judged ahead (0064 §3): their
   * unsolicited outbound touches, on every channel, and the unsolicited steps
   * still planned of their other enrolments that carry a plan, from when each
   * was enrolled — a step whose touch is recorded counts once, as the touch.
   * Served by the touch index on (person, occurred_at) and the registry's
   * unique on (person, sequence).
   */
  const reaching = async (personId: string, sequenceKey: string): Promise<Date[]> => {
    const touched = await deps.db
      .select({ at: touchTable.occurredAt, messageId: touchTable.messageId })
      .from(touchTable)
      .where(and(eq(touchTable.personId, personId), eq(touchTable.direction, "outbound"), eq(touchTable.unsolicited, true)));
    const sent = new Set(touched.flatMap((t) => (t.messageId ? [t.messageId] : [])));
    const others = await deps.db
      .select({ plan: enrolment.plan, enrolledAt: enrolment.enrolledAt, createdAt: enrolment.createdAt })
      .from(enrolment)
      .where(and(eq(enrolment.personId, personId), ne(enrolment.sequenceKey, sequenceKey), inArray(enrolment.state, ["pending", "enrolled"])));
    const planned = others.flatMap((o) => {
      if (!o.plan) return [];
      const times = planTimes(o.enrolledAt ?? o.createdAt, o.plan);
      return o.plan.flatMap((p, i) => (p.unsolicited && !sent.has(p.messageId) ? [times[i]!] : []));
    });
    return [...touched.map((t) => t.at), ...planned];
  };

  /** Moves a registry row, attributed to this run. */
  const settleRow = (id: string, change: { state: "pending" | "enrolled" | "refused"; enrolledAt?: Date; refusal?: string | null; plan?: (typeof enrolment.$inferInsert)["plan"] }) =>
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

    /* 1b. The protected it already reached, stopped first (0057) -------- */

    // Every enrolment still running at an account protection now excludes,
    // suspended before anyone new is enrolled, with the protection this run
    // just read. A run that cannot stop the protected it already reached
    // does not reach anyone new. This hook is not 0004's promise: it runs
    // only when someone enrols (see `protected.ts`).
    report.protectedStop = await stopProtected({ db: deps.db, registry: deps.registry }, protection, ctx);
    if (report.protectedStop.refused.length > 0) {
      throw new Stop(`enrolments already running at protected accounts could not all be stopped, so nobody new is enrolled (decision 0057): ${report.protectedStop.refused.join("; ")}`);
    }

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

    /* 2b. From a list: the provider's steps, against the templates (0064) */

    /** What each variant's steps render, once the provider's steps agree with its templates. */
    const renders = new Map<string, StepRender[]>();
    /** Each step's delay after the one before, as the provider will run it. */
    const delays = new Map<number, number>();
    if (fromList) {
      const read = await sequencer.readSteps!(request.sequenceKey, ctx);
      if (!read.ok) throw new Stop(`the steps of "${request.sequenceKey}" cannot be read: ${read.error.code}: ${read.error.message}`);
      const elsewhere = [...new Set(read.value.steps.map((s) => s.channel).filter((c) => c !== request.channel))];
      if (elsewhere.length > 0) {
        throw new Stop(`"${request.sequenceKey}" runs steps on ${elsewhere.map((c) => `"${c}"`).join(", ")}, and this enrolment is on "${request.channel}": one enrolment carries one channel until the registry row holds several (decision 0064)`);
      }
      for (const s of read.value.steps) delays.set(s.step, s.afterPreviousMinutes);
      for (const [variant, plan] of fromList.plans) {
        const agreed = compareSteps(read.value, plan);
        if (!agreed.agrees) throw new Stop(`the provider's steps of "${request.sequenceKey}" and the templates of variant "${variant}" disagree, so the plan would not be the one run (decision 0064 §5): ${agreed.disagreements.join("; ")}`);
        renders.set(variant, agreed.renders);
      }
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
      if (fromList) {
        for (const { companyId } of fromList.companies) {
          await skip({ reason: "unreachable", company: { attributes: {}, externalId: companyId } as unknown as TargetCompany, detail: "a company on a list names nobody to write to" });
        }
        for (const group of fromList.groups) {
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

        // The objection, through the one reader (0055): an opt-out on record,
        // or a key in the register, which finds an erased objector again. It
        // also says who this is on record, for the registry below. Reads
        // only, so a dry run asks it too.
        const objection = await readObjection(deps.db, deps.fingerprints, { identity: person });
        if (objection.answer === "cannot_answer" && objection.stops) throw new Stop(`the objection cannot be read: ${objection.why}`);
        if (objection.answer === "cannot_answer") {
          await skip({ reason: "unreachable", person, company, detail: `the registry cannot tell who this is: ${objection.why}` });
          continue;
        }
        if (objection.answer === "objected") {
          await skip({ reason: "opted_out", person, company, detail: objection.by === "record" ? "opted out" : "objected before an erasure; the register holds it" });
          continue;
        }
        const known: { id: string } | { none: true } = objection.personId !== undefined ? { id: objection.personId } : { none: true };
        let row = "id" in known ? await registryRow(known.id) : undefined;
        if (row?.state === "enrolled") {
          await skip({ reason: "duplicate", person, company, detail: "already enrolled in this sequence, by the registry" });
          continue;
        }
        // Terminal (0051): a person suspended from a sequence is not enrolled
        // in it again. Whatever the provider now says of them is not asked:
        // the registry, not the provider, records the decision to stop.
        //
        // What this does not reach: a person found again after their erasure.
        // Erasure suspends their enrolments and keeps the rows naming nobody
        // (0053, 0056), so none of them is found here: a later run that finds
        // the person records a new one, with no row in this sequence. What
        // stops that is 0052's register, once 0055's reader reads it; until
        // then, the provisional refusal above.
        if (row?.state === "suspended") {
          await skip({ reason: "suspended", person, company, detail: "suspended from this sequence, by the registry: not enrolled in it again (decision 0051)" });
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
        // A run died after writing the registry, and the provider holds the
        // person. Only the row's key says the enrolment it holds is this one
        // (0060): an address names a person, and someone else may have put
        // them in the same sequence. Under the key, it is confirmed rather
        // than made twice, having consumed its capacity then. Under no key or
        // another, the key is replayed below: the provider answers this
        // enrolment, or a conflict — never confirmed on a status alone.
        const replaying = row?.state === "pending" && current.value.state !== "unknown";
        if (replaying && current.value.idempotencyKey === row!.idempotencyKey) {
          if (!request.dryRun) await settleRow(row!.id, { state: "enrolled", enrolledAt: now() });
          report.reconciled.push({ person, company, state: current.value.state });
          continue;
        }
        if (!replaying && current.value.state !== "unknown") {
          await skip({ reason: "duplicate", person, company, detail: `already in the sequence (${current.value.state})` });
          continue;
        }
        if (!replaying && budget <= 0) {
          await skip({ reason: "capacity", person, company, detail: "no capacity left on the given senders" });
          continue;
        }

        // From a list (0064): the messages this person's sequence carries,
        // one approved draft per step of one variant, each written through
        // the gate before anyone is reached. A step's message refused by the
        // gate reaches nobody; the messages already written stay, as what
        // would have been said, and a replay writes each once.
        let carried: { variables: Record<string, string>; variant: string; plan: NonNullable<(typeof enrolment.$inferInsert)["plan"]> } | undefined;
        if (fromList) {
          if (!("id" in known)) {
            await skip({ reason: "unreachable", person, company, detail: "the list names someone no longer on record" });
            continue;
          }
          const drafts = await deps.db
            .select({ id: draft.id, state: draft.state, step: template.step, variant: template.variant, subject: draft.renderedSubject, body: draft.renderedBody, decidedBy: draft.decidedBy })
            .from(draft)
            .innerJoin(template, eq(template.id, draft.templateId))
            .where(and(eq(draft.experimentId, request.fromList!.experimentId), eq(draft.personId, known.id)));
          const approved = drafts.filter((d) => d.state === "approved");
          const variants = [...new Set(approved.map((d) => d.variant))];
          const steps = variants.length === 1 ? renders.get(variants[0]!) : undefined;
          const missing = steps?.filter((r) => !approved.some((d) => d.step === r.step)) ?? [];
          if (!steps || missing.length > 0) {
            const why =
              variants.length === 0
                ? "no approved draft"
                : variants.length > 1
                  ? `approved drafts of ${variants.length} variants`
                  : `no approved draft for step ${missing.map((r) => r.step).join(", ")}`;
            await skip({ reason: "not_drafted", person, company, detail: `${why}: every step of the sequence carries one (decision 0064)` });
            continue;
          }
          // 0064 §3: the whole plan, judged ahead against what already
          // reaches the person, before any message is written.
          if (request.fromList!.unsolicited) {
            const verdict = judgeAhead(
              await reaching(known.id, request.sequenceKey),
              planTimes(now(), steps.map((r) => ({ afterPreviousMinutes: delays.get(r.step) ?? 0 }))),
              request.fromList!.cap!,
            );
            if (!verdict.within) {
              await skip({
                reason: "capped",
                person,
                company,
                detail: `${verdict.count} unsolicited touches between ${verdict.from.toISOString()} and ${verdict.to.toISOString()}, past the cap of ${request.fromList!.cap!.max} in ${request.fromList!.cap!.withinDays} days, counting this plan (decision 0064 §3)`,
              });
              continue;
            }
          }
          const variables: Record<string, string> = {};
          const plan: NonNullable<(typeof enrolment.$inferInsert)["plan"]> = [];
          const refusals: string[] = [];
          for (const r of steps) {
            const d = approved.find((x) => x.step === r.step)!;
            variables[r.body] = d.body ?? "";
            if (r.subject) variables[r.subject] = d.subject ?? "";
            if (request.dryRun) continue;
            const written = await writeMessage(
              deps.db,
              deps.fingerprints,
              {
                key: messageKey(d.id),
                personId: known.id,
                channel: request.channel,
                ...(r.subject && d.subject ? { subject: d.subject } : {}),
                body: d.body ?? "",
                unsolicited: request.fromList!.unsolicited,
                ...(request.fromList!.unsolicited ? { cadence: "judged_ahead" as const } : {}),
                experimentId: request.fromList!.experimentId,
                ...(d.decidedBy ? { approvedBy: d.decidedBy } : {}),
                ...(request.fromList!.reactiveWithinMinutes !== undefined ? { reactiveWithinMinutes: request.fromList!.reactiveWithinMinutes } : {}),
                actor: request.actor,
                runId: open.id,
              },
              now(),
            );
            if (!written.ok) {
              refusals.push(`step ${r.step}: ${written.refused.join("; ")}`);
              break;
            }
            plan.push({ step: r.step, afterPreviousMinutes: delays.get(r.step) ?? 0, messageId: written.messageId, unsolicited: request.fromList!.unsolicited });
          }
          if (refusals.length > 0) {
            await skip({ reason: "refused", person, company, detail: `the message gate refused, so nobody is reached (decision 0038): ${refusals.join("; ")}` });
            continue;
          }
          carried = { variables, variant: variants[0]!, plan };
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
            await settleRow(row.id, { state: "pending", refusal: null, ...(carried ? { plan: carried.plan } : {}) });
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
                ...(carried ? { plan: carried.plan } : {}),
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
            ...(carried ? { variables: carried.variables } : {}),
            attribution: { runId: open.id, ...(carried ? { experimentSlug: fromList!.experimentSlug, variant: carried.variant } : {}) },
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
        // Confirmed by the provider recognising the key: reconciled, not a new enrolment.
        if (replaying) {
          report.reconciled.push({ person, company, state: done.value.state });
          continue;
        }
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
