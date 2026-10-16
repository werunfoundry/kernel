/**
 * gtm/runtime — the sourcing path (decision 0031).
 *
 * From the target list's companies to people worth contacting, with their
 * keys, recorded — and everyone excluded on the way, with why. It enrols
 * nobody and writes nothing to a provider; the paid step is completion.
 *
 * In this order, because each step is what decides whether the next one is
 * paid for:
 *
 * 1. **Protection**, read whole and fresh (0019). Unreadable stops the run.
 * 2. **The company pass**, over every candidate before anything is spent: a
 *    protected company, or one the CRM already knows, is excluded, and its
 *    people are never looked up. The CRM is asked about every remaining
 *    domain at once, in as few requests as its adapter can make. A CRM that
 *    cannot answer stops the run here — before any money is spent, not
 *    halfway through.
 * 3. **People**, from the people source, up to the run's ceiling.
 * 4. **Completion**, through the enrichment sources in sequence (0030). Each
 *    person completed counts against `maxPeople`, which is required: a paid
 *    path has no default ceiling.
 * 5. **The person pass, on the completed identity**: protection again, the
 *    CRM by address, the global opt-out. A person found by a people source
 *    usually has no address, so before completion these checks would run and
 *    conclude nothing; after it, they check the identity that would be
 *    contacted. A person left with no address is excluded, since neither
 *    check can say anything about them (0030: a check that cannot conclude
 *    is worse than none).
 * 6. **Recording** the kept person by the keys the completion attested.
 *
 * A paid source that could not look for a reason that is not the person's —
 * unauthorized, rate limited, unavailable — stops the run, with its message,
 * which names the job when there is one. The next person is not tried: the
 * same failure would spend again for nothing. Nothing is retried.
 *
 * Every company and person looked at gets a row in `sourcing_result`, kept
 * or excluded, dry run or not. A dry run writes its run and those rows, and
 * nothing else: no person, no company, and no paid submission — a completion
 * stopped by the dry run is `simulated`, and nothing after it is decided.
 */

import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityVocabulary } from "@werunfoundry/core/identity";
import { checkIdentity, hostOf, normalizeIdentity } from "@werunfoundry/core/identity";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, OpenRun, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import type { Crm, CrmCompany } from "@werunfoundry/relations/contracts/crm";
import type { Cost, Enrichment, KeyStatus, SequenceStep } from "@werunfoundry/relations/contracts/enrichment";
import { completeInSequence } from "@werunfoundry/relations/contracts/enrichment";
import type { PeopleSource } from "@werunfoundry/relations/contracts/people-source";
import { person as personTable } from "@werunfoundry/relations/db/schema";
import { findPerson, recordCompany, recordPerson } from "@werunfoundry/relations/runtime/record";

import type { TargetCompany, TargetList, TargetQuery } from "../contracts/target-list.js";
import { sourcingResult } from "../db/schema.js";
import { readAcknowledged } from "./acknowledge.js";
import type { Protection } from "./protection.js";
import { readProtection } from "./protection.js";

/** The contract names this path asks the registry for. */
export const SOURCING_CONTRACTS = { targetList: "target_list", peopleSource: "people_source", enrichment: "enrichment", crm: "crm" } as const;

export type Outcome = "kept" | "protected" | "known_to_crm" | "opted_out" | "duplicate" | "incomplete" | "unreachable" | "not_reached" | "simulated";

export interface SourceRequest {
  query?: TargetQuery;
  /** How many people to look up at each company. */
  peoplePerCompany?: number;
  /**
   * The most people this run completes — and so may pay for. Required:
   * there is no default number of paid lookups.
   */
  maxPeople: number;
  /** The key kinds a kept person must have — `["email"]` for an email campaign. */
  want: string[];
  /** As for enrolment: how old the protected set may be, in minutes. */
  protectedMaxAgeMinutes: number;
  dryRun: boolean;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
}

export interface Looked {
  pass: "company" | "person";
  outcome: Outcome;
  company: TargetCompany;
  /** The person, as completed when completion ran; absent for a whole company. */
  person?: Identity;
  detail: string;
  /** What the provider said about keys it added, for a completed person. */
  said?: KeyStatus[];
  /** What completing this person cost, per source. */
  cost?: { provider: string; cost: Cost }[];
  /** The recorded person, for a kept one in a live run. */
  personId?: string;
}

export interface SourceReport {
  runId: string;
  dryRun: boolean;
  /** "succeeded", "partial" (stopped after keeping someone), or "failed". */
  status: "succeeded" | "partial" | "failed";
  stoppedBy?: string;
  /** Distinct protected accounts (decision 0033); `protectedRows` counts the source's rows. */
  protectedAccounts: number;
  protectedRows: number;
  /**
   * What protection matched on, and the acknowledged customers it could not
   * protect (0034). Absent when the run stopped before protection was read.
   */
  protection?: Pick<Protection, "surface" | "unkeyedRowsOfCoveredCustomers" | "uncovered">;
  candidates: number;
  /** Every company and person looked at, in order. */
  looked: Looked[];
  /** People searches made, one per company sourced. */
  peopleSearches: number;
  /** People taken under the ceiling — `maxPeople` bounds this number. */
  peopleTaken: number;
  /** People at least one enrichment source was asked about: each one could be paid for. */
  completions: number;
  /** What completion cost in all, per provider and unit. */
  spent: { provider: string; amount: number; unit: string }[];
  /**
   * What the company pass spared, by not looking at excluded companies'
   * people: one search each, and at most `peoplePerCompany` completions each.
   */
  avoidedByCompanyPass: { companies: number; peopleSearches: number; completionsAtMost: number };
  /** People excluded before completion — a duplicate, an address already protected — each one completion not paid for. */
  avoidedBeforeCompletion: number;
  /**
   * What was spent completing people then excluded — by the person pass, or
   * for want of the key asked for. The person pass can only run once an
   * address exists, so what it excludes was already paid for; this says how
   * much.
   */
  spentOnExcludedPeople: { provider: string; amount: number; unit: string }[];
  /** Whether the run row was closed with this outcome. */
  recorded: boolean;
}

export interface SourceDeps {
  db: Database;
  registry: Registry;
  identity: IdentityVocabulary;
  now?: () => Date;
}

class Stop extends Error {}

/**
 * What is kept of a sentence the run records — a stop, an exclusion's
 * detail. Long enough for a provider's answer quoted verbatim (a 429 with
 * its headers and body); a bound, not a summary, and it says when it cut.
 */
const RECORDED = 8_000;
const bounded = (s: string) => (s.length <= RECORDED ? s : `${s.slice(0, RECORDED)} …(cut at ${RECORDED} characters)`);

const keysOf = (p: Identity) => p.keys.map((k) => `${k.kind}:${k.network ?? ""}:${k.value}`).sort();
const subjectOfPerson = (p: Identity) => `person:${createHash("sha256").update(keysOf(p).join("\n")).digest("hex").slice(0, 32)}`;
const subjectOfCompany = (c: TargetCompany) => `company:${c.domain ?? c.externalId ?? c.name ?? JSON.stringify(c)}`;

function total(costs: { provider: string; cost: Cost }[]) {
  const sums = new Map<string, { provider: string; amount: number; unit: string }>();
  for (const { provider, cost } of costs) {
    const k = `${provider}\n${cost.unit}`;
    const s = sums.get(k) ?? { provider, amount: 0, unit: cost.unit };
    s.amount += cost.amount;
    sums.set(k, s);
  }
  return [...sums.values()];
}

const costsOf = (steps: SequenceStep[]) => steps.flatMap((s) => (s.cost ? [{ provider: s.provider, cost: s.cost }] : []));

/**
 * What the CRM knows of each domain — in as few requests as its adapter
 * allows, and one domain at a time from an adapter that cannot answer for
 * several. Any failure stops the run before anything is spent, and so does
 * an answer that leaves a domain out: unanswered is not unknown.
 */
async function knownToCrm(crm: Crm, hosts: string[], ctx: CallContext): Promise<ReadonlyMap<string, CrmCompany | null>> {
  const stop = (why: string) => new Stop(`the CRM could not be read, so nothing was spent: ${why}`);
  if (hosts.length === 0) return new Map();
  if (crm.findCompaniesByDomains) {
    const answer = await crm.findCompaniesByDomains(hosts, ctx);
    if (!answer.ok) throw stop(`${answer.error.code}: ${answer.error.message}`);
    const unanswered = hosts.filter((h) => answer.value.get(h) === undefined);
    if (unanswered.length > 0) throw stop(`it gave no answer for ${unanswered.join(", ")}`);
    return answer.value;
  }
  const known = new Map<string, CrmCompany | null>();
  for (const host of hosts) {
    const one = await crm.findCompanyByDomain(host, ctx);
    if (!one.ok) throw stop(`${one.error.code}: ${one.error.message}`);
    known.set(host, one.value);
  }
  return known;
}

export async function source(deps: SourceDeps, request: SourceRequest): Promise<SourceReport> {
  const now = deps.now ?? (() => new Date());
  const targets = deps.registry.get(SOURCING_CONTRACTS.targetList) as TargetList | undefined;
  const people = deps.registry.get(SOURCING_CONTRACTS.peopleSource) as PeopleSource | undefined;
  const crm = deps.registry.get(SOURCING_CONTRACTS.crm) as Crm | undefined;
  const sources = deps.registry.sequence<Enrichment>(SOURCING_CONTRACTS.enrichment);
  // Configuration, checked before a run is opened. The CRM is not optional:
  // without it, "unknown to the CRM" would be assumed, not read.
  if (!targets) throw new Error(`no adapter is bound to "${SOURCING_CONTRACTS.targetList}"`);
  if (!people) throw new Error(`no adapter is bound to "${SOURCING_CONTRACTS.peopleSource}"`);
  if (!crm) throw new Error(`no adapter is bound to "${SOURCING_CONTRACTS.crm}": the CRM is an exclusion source, and sourcing without it would contact people it knows`);
  if (sources.length === 0) throw new Error(`no adapter is bound to "${SOURCING_CONTRACTS.enrichment}"`);
  if (!Number.isInteger(request.maxPeople) || request.maxPeople < 1) throw new Error("maxPeople must be a positive whole number: there is no default number of paid lookups");
  if (request.want.length === 0) throw new Error("want must name at least one key kind a kept person must have");
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");
  const perCompany = request.peoplePerCompany ?? 5;

  const open: OpenRun = await openRun(deps.db, {
    processKey: "gtm.source",
    trigger: request.trigger,
    actor: request.actor,
    dryRun: request.dryRun,
  });
  const ctx: CallContext = open.context;
  const report: SourceReport = {
    runId: open.id,
    dryRun: request.dryRun,
    status: "succeeded",
    protectedAccounts: 0,
    protectedRows: 0,
    candidates: 0,
    looked: [],
    peopleSearches: 0,
    peopleTaken: 0,
    completions: 0,
    spent: [],
    avoidedByCompanyPass: { companies: 0, peopleSearches: 0, completionsAtMost: 0 },
    avoidedBeforeCompletion: 0,
    spentOnExcludedPeople: [],
    recorded: false,
  };

  /** Kept in the report and in `sourcing_result`, dry run or not. */
  const note = async (l: Looked, subject: string) => {
    report.looked.push(l);
    await deps.db
      .insert(sourcingResult)
      .values({
        runId: open.id,
        pass: l.pass,
        outcome: l.outcome,
        detail: bounded(l.detail),
        ...(l.person ? { person: l.person } : {}),
        // The company's keys too: an enrolment reading this run back checks
        // protection again, and matches on the company id as well as the
        // domain (decision 0033).
        company: {
          ...(l.company.domain ? { domain: l.company.domain } : {}),
          ...(l.company.externalId ? { externalId: l.company.externalId } : {}),
          ...(l.company.name ? { name: l.company.name } : {}),
          ...(l.company.identity ? { identity: l.company.identity } : {}),
        },
        ...(l.personId ? { personId: l.personId } : {}),
        ...(l.said ? { said: l.said } : {}),
        ...(l.cost ? { cost: l.cost } : {}),
        subject,
      })
      .onConflictDoNothing({ target: [sourcingResult.runId, sourcingResult.subject] });
  };

  const allCosts: { provider: string; cost: Cost }[] = [];
  const excludedCosts: { provider: string; cost: Cost }[] = [];

  try {
    /* 1. Protection ---------------------------------------------------- */

    // The customers a person acknowledged as uncovered (0034): read here,
    // never written by a run.
    const acknowledged = await readAcknowledged(deps.db);
    const read = await readProtection(targets, { maxAgeMinutes: request.protectedMaxAgeMinutes, now: now(), acknowledged }, ctx);
    if (!read.ok) throw new Stop(read.stop);
    const protection = read.protection;
    report.protectedAccounts = protection.accounts;
    report.protectedRows = protection.rows;
    report.protection = { surface: protection.surface, unkeyedRowsOfCoveredCustomers: protection.unkeyedRowsOfCoveredCustomers, uncovered: protection.uncovered };

    /* 2. The company pass, before anything is spent ----------------------- */

    const candidates = await targets.candidates(request.query ?? {}, ctx);
    if (!candidates.ok) throw new Stop(`candidates unavailable: ${candidates.error.code}: ${candidates.error.message}`);
    report.candidates = candidates.value.items.length;

    const kept: { company: TargetCompany; identity: Identity }[] = [];
    const excludeCompany = async (company: TargetCompany, outcome: Outcome, detail: string) => {
      report.avoidedByCompanyPass.companies++;
      report.avoidedByCompanyPass.peopleSearches++;
      report.avoidedByCompanyPass.completionsAtMost += perCompany;
      await note({ pass: "company", outcome, company, detail }, subjectOfCompany(company));
    };
    // What protection and the domain decide comes first, so that the CRM is
    // asked only about what is left, and about all of it at once.
    type Pending = { company: TargetCompany } & ({ host: string } | { excluded: { outcome: Outcome; detail: string } });
    const pending = candidates.value.items.map((company): Pending => {
      if (protection.company(company)) return { company, excluded: { outcome: "protected", detail: "the account is protected" } };
      const host = company.domain ? hostOf(company.domain) : "";
      if (!host) return { company, excluded: { outcome: "unreachable", detail: "no domain: neither the CRM nor protection can recognise it" } };
      return { company, host };
    });
    const known = await knownToCrm(crm, [...new Set(pending.flatMap((p) => ("host" in p ? [p.host] : [])))], ctx);

    for (const p of pending) {
      const { company } = p;
      if ("excluded" in p) {
        await excludeCompany(company, p.excluded.outcome, p.excluded.detail);
        continue;
      }
      const { host } = p;
      const theirs = known.get(host);
      if (theirs) {
        await excludeCompany(company, "known_to_crm", `known to the CRM as ${theirs.ref.externalId}`);
        continue;
      }
      // As the target list attests it (0024, 0029); a key the vocabulary
      // refuses is not passed on as if it were good.
      const identity = normalizeIdentity(
        { subject: "company", keys: [{ kind: "domain", value: host }, ...(company.identity?.keys.filter((k) => k.kind !== "domain") ?? [])] },
        deps.identity,
      );
      const malformed = checkIdentity(identity, deps.identity).filter((i) => i.severity === "error");
      if (malformed.length > 0) {
        await excludeCompany(company, "unreachable", `the target list's keys for it are not valid: ${malformed.map((i) => i.message).join("; ")}`);
        continue;
      }
      kept.push({ company, identity });
    }

    /* 3–6. People, completion, the person pass, recording ------------------ */

    let budget = request.maxPeople;
    const seen = new Set<string>();
    for (const { company, identity: companyIdentity } of kept) {
      if (budget <= 0) {
        await note({ pass: "company", outcome: "not_reached", company, detail: `the run's ceiling of ${request.maxPeople} people was reached first` }, subjectOfCompany(company));
        continue;
      }
      const page = await people.peopleAt({ company: companyIdentity, limit: perCompany }, ctx);
      report.peopleSearches++;
      if (!page.ok) {
        await note({ pass: "company", outcome: "unreachable", company, detail: `its people could not be looked up: ${page.error.code}: ${page.error.message}` }, subjectOfCompany(company));
        continue;
      }

      let companyRow: { id: string } | { conflict: string } | undefined;
      for (const one of page.value.items.slice(0, perCompany)) {
        const found = normalizeIdentity(one.identity, deps.identity);
        const subject = subjectOfPerson(found);
        const exclude = (outcome: Outcome, detail: string, extra: Partial<Looked> = {}) =>
          note({ pass: "person", outcome, company, person: found, detail, ...extra }, subject);

        if (budget <= 0) {
          await exclude("not_reached", `the run's ceiling of ${request.maxPeople} people was reached first`);
          continue;
        }
        if (seen.has(subject)) {
          report.avoidedBeforeCompletion++;
          await exclude("duplicate", "already met in this run");
          continue;
        }
        seen.add(subject);
        // Free, so asked before paying: an address the people source already
        // gave may be protected.
        if (protection.person(found)) {
          report.avoidedBeforeCompletion++;
          await exclude("protected", "an address it already had is on a protected domain; not completed");
          continue;
        }

        budget--;
        report.peopleTaken++;
        const completed = await completeInSequence(sources, { identity: found, want: request.want }, deps.identity, ctx);
        // Asked: a step was recorded, or a source failed. A person who already
        // had every key wanted was asked of nobody, and cost nothing.
        if (completed.steps.length > 0 || !completed.ok) report.completions++;
        const cost = costsOf(completed.steps);
        allCosts.push(...cost);
        const spent = cost.length > 0 ? { cost } : {};
        if (!completed.ok) {
          const e = completed.error;
          await exclude("unreachable", `${completed.provider} could not look: ${e.code}: ${e.message}`, spent);
          // The person's problem, or the provider's. Only the first lets the
          // run go on: the others would fail — and spend — the same way.
          if (e.code === "invalid" || e.code === "not_found") continue;
          throw new Stop(`enrichment stopped at ${completed.provider}: ${e.code}: ${e.message}`);
        }
        const person = completed.identity;
        const said = completed.steps.flatMap((s) => s.said ?? []);
        const what = { person, ...spent, ...(said.length ? { said } : {}) };
        if (completed.missing.length > 0) {
          const simulated = completed.steps.some((s) => s.outcome === "simulated");
          await note(
            {
              pass: "person",
              outcome: simulated ? "simulated" : "incomplete",
              company,
              detail: simulated
                ? "a dry run: the paid completion was not submitted, and nothing after it was decided"
                : `no ${completed.missing.join(", ")} found (${completed.steps.map((s) => `${s.provider}: ${s.outcome}`).join("; ") || "no source finds it"})`,
              ...what,
            },
            subject,
          );
          if (!simulated) excludedCosts.push(...cost);
          continue;
        }

        // The person pass, on the identity that would be contacted.
        const excludeAfter = async (outcome: Outcome, detail: string) => {
          excludedCosts.push(...cost);
          await note({ pass: "person", outcome, company, detail, ...what }, subject);
        };
        const addresses = person.keys.filter((k) => k.kind === "email").map((k) => k.value);
        if (addresses.length === 0) {
          await excludeAfter("unreachable", "no address: neither protection nor the CRM can say anything about this person");
          continue;
        }
        if (protection.person(person)) {
          await excludeAfter("protected", "an address completion gave it is on a protected domain");
          continue;
        }
        let knownAs: string | undefined;
        for (const address of addresses) {
          const known = await crm.findPersonByEmail(address, ctx);
          if (!known.ok) {
            await excludeAfter("unreachable", `the CRM could not be read: ${known.error.code}: ${known.error.message}`);
            throw new Stop(`the CRM could not be read: ${known.error.code}: ${known.error.message}`);
          }
          if (known.value) {
            knownAs = known.value.ref.externalId;
            break;
          }
        }
        if (knownAs !== undefined) {
          await excludeAfter("known_to_crm", `known to the CRM as ${knownAs}`);
          continue;
        }
        const recorded = await findPerson(deps.db, person);
        if ("conflict" in recorded) {
          await excludeAfter("unreachable", `the registry cannot tell who this is: ${recorded.conflict}`);
          continue;
        }
        if ("id" in recorded) {
          const [row] = await deps.db.select({ optedOutAt: personTable.optedOutAt }).from(personTable).where(eq(personTable.id, recorded.id));
          if (row?.optedOutAt) {
            await excludeAfter("opted_out", "opted out");
            continue;
          }
        }

        if (request.dryRun) {
          await note({ pass: "person", outcome: "kept", company, detail: "kept; a dry run records nobody", ...what }, subject);
          continue;
        }
        companyRow ??= await recordCompany(deps.db, companyIdentity, company.name ? { name: company.name } : {});
        if ("conflict" in companyRow) {
          await excludeAfter("unreachable", `the recorded companies disagree about this one: ${companyRow.conflict}`);
          continue;
        }
        const written = await recordPerson(deps.db, person, {
          ...(one.display?.fullName ? { fullName: one.display.fullName } : {}),
          companyId: companyRow.id,
        });
        if ("conflict" in written) {
          await excludeAfter("unreachable", `the registry cannot tell who this is: ${written.conflict}`);
          continue;
        }
        await note({ pass: "person", outcome: "kept", company, detail: "kept and recorded", personId: written.id, ...what }, subject);
      }
    }
  } catch (thrown) {
    if (!(thrown instanceof Stop)) {
      await open
        .finish({ status: "failed", error: bounded(thrown instanceof Error ? thrown.message : String(thrown)) })
        .catch(() => {});
      throw thrown;
    }
    report.stoppedBy = thrown.message;
    report.status = report.looked.some((l) => l.outcome === "kept") ? "partial" : "failed";
  }
  report.spent = total(allCosts);
  report.spentOnExcludedPeople = total(excludedCosts);

  try {
    await open.finish(
      report.status === "succeeded" ? { status: "succeeded" } : { status: report.status, error: bounded(report.stoppedBy ?? "") },
    );
    report.recorded = true;
  } catch (error) {
    report.stoppedBy = `${report.stoppedBy ? `${report.stoppedBy}; ` : ""}the run could not be closed: ${(error as Error).message.split("\n")[0]}`;
  }
  return report;
}
