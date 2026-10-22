/**
 * acquisition/runtime — stopping what already runs at an account that became
 * protected (decision 0057, completed by 0060).
 *
 * **0004's promise — a newly protected account is withdrawn from its running
 * sequences — is kept only as often as this act runs.** Two occasions run it:
 * the start of every enrolment run (`enrol()`), and `kernel-stop-protected`,
 * which the instance schedules. Between two runs, an account that became
 * protected keeps receiving every step its sequences send. The hook at
 * enrolment alone is not that promise: it runs when someone enrols, so an
 * instance that stops enrolling stops withdrawing. The command is how an
 * instance keeps it, at the rate the instance chooses; the kernel does not
 * choose that rate, and does not claim it. What it says instead: each run that
 * held the promise writes `protection_held`, and the latest row is how far
 * the promise is known to hold.
 *
 * From protection read as enrolment reads it — fresh, failing closed, with
 * the same verdict (0044) — every enrolment still running is judged by the
 * company its row names, as the registry recorded it, and by the person's
 * addresses. For each one protection excludes:
 *
 * 1. **It is suspended** through the sequencer bound to its channel
 *    (`suspendEnrolment`, 0051): an enrolled row recorded with the read-back
 *    its adapter returned; a
 *    pending one asked of the provider first, and confirmed only by its key
 *    (0060). This keeps the promise.
 * 2. **Its account is suppressed** at that provider: by the account's keys,
 *    and by each person's keys those do not cover. Defence in depth (0012):
 *    it reaches a colleague the kernel never enrolled, and it is never the
 *    record that anyone was stopped.
 *
 * Any refusal — of a suspension or a suppression — fails the act, naming the
 * adapter and what it answered; the caller stops, and running again is the
 * remedy. Only an act that met no refusal writes `protection_held`, and a dry
 * run writes nothing.
 *
 * What it does not reach (0057): the time between two runs; the steps already
 * scheduled before a suspension takes effect; a company protected only by the
 * target list's own identifier, which the registry does not record; whoever
 * was enrolled at the provider by hand; and an account that leaves the
 * protected set, which is not resumed.
 */

import { createHash } from "node:crypto";

import { desc, eq, inArray } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";
import { run as runTable } from "@werunfoundry/core/db/schema";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { company, person } from "@werunfoundry/relations/db/schema";

import type { Sequencer } from "../contracts/sequencer.js";
import type { TargetCompany, TargetList } from "../contracts/target-list.js";
import { enrolment, protectionHeld } from "../db/schema.js";
import { readAcknowledged } from "./acknowledge.js";
import { CONTRACTS } from "./enrol.js";
import type { Protection } from "./protection.js";
import { readProtection } from "./protection.js";
import type { Suspendable } from "./suspend.js";
import { personIdentity, reachFor, suspendEnrolment } from "./suspend.js";

/** Said by the command, and by `kernel-enrol` after its hook: what the act is not. */
export const PROMISE =
  "0004's promise — a newly protected account is withdrawn from its running sequences — holds only as often as kernel-stop-protected or an enrolment run runs. " +
  "Between two runs, an account that became protected keeps receiving every step its sequences send. " +
  "The hook at enrolment alone is not that promise: an instance that stops enrolling stops withdrawing. The instance schedules kernel-stop-protected, at the rate it chooses (decision 0057).";

const REASON = "the account became protected (decisions 0004, 0057)";

export interface ProtectedStop {
  /** When the protected set acted on was computed, as its source said. */
  protectedAsOf: string;
  accounts: number;
  /** Each running enrolment protection excludes, why, and what became of it. */
  stops: { enrolment: string; sequenceKey: string; state: "pending" | "enrolled"; why: string; outcome: string }[];
  /** Each suppression asked, through which sequencer, and what it listed. */
  suppressions: { through: string; target: string; outcome: string }[];
  /** What failed the act, each naming the adapter and its answer. */
  refused: string[];
  /** Whether `protection_held` was written: a live act that met no refusal. */
  held: boolean;
  /**
   * Protected accounts known by the source's own identifier alone (0068): the
   * registry records no such identifier for any company, so an enrolment at
   * one of them, if there is one, is not found and keeps running. Named, and
   * not a refusal: refusing would stop nobody else either.
   */
  unreached: { externalId: string; name?: string }[];
}

/** The company the registry recorded, as protection judges a candidate (0024). */
function asCandidate(c: { domain: string | null; externalId: string | null; name: string | null }): TargetCompany {
  const keys: IdentityKey[] = [];
  if (c.domain) keys.push({ kind: "domain", value: c.domain });
  const cut = c.externalId?.indexOf(":") ?? -1;
  if (c.externalId && cut > 0) keys.push({ kind: "social_company_id", network: c.externalId.slice(0, cut), value: c.externalId.slice(cut + 1) });
  return {
    ...(c.domain ? { domain: c.domain } : {}),
    ...(c.name ? { name: c.name } : {}),
    identity: { subject: "company", keys },
    attributes: {},
  };
}

const said = (keys: IdentityKey[]) => keys.map((k) => (k.network ? `${k.kind}@${k.network} ${k.value}` : k.value)).join(", ");
const keyOf = (target: Identity) =>
  createHash("sha256")
    .update(["suppress", target.subject, ...target.keys.map((k) => `${k.kind}:${k.network ?? ""}:${k.value}`).sort()].join("\n"))
    .digest("hex")
    .slice(0, 32);
const covered = (host: string, domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * The act, inside a run its caller opened: `enrol()` at its start, or
 * `stopProtectedRun()` for the command. Protection is the caller's read, so
 * that a run reads it once.
 */
export async function stopProtected(deps: { db: Database; registry: Registry }, protection: Protection, ctx: CallContext): Promise<ProtectedStop> {
  const out: ProtectedStop = { protectedAsOf: protection.asOf, accounts: protection.accounts, stops: [], suppressions: [], refused: [], held: false, unreached: protection.bySourceIdOnly };

  // Every enrolment a provider may still be sending for. Both states, as
  // 0060 has it: a pending row may be held at the provider all the same.
  const rows = await deps.db
    .select({
      id: enrolment.id,
      personId: enrolment.personId,
      companyId: enrolment.companyId,
      sequenceKey: enrolment.sequenceKey,
      channel: enrolment.channel,
      idempotencyKey: enrolment.idempotencyKey,
      state: enrolment.state,
      provider: enrolment.provider,
      email: person.email,
      externalId: person.externalId,
      companyDomain: company.domain,
      companyExternalId: company.externalId,
      companyName: company.name,
    })
    .from(enrolment)
    .innerJoin(person, eq(person.id, enrolment.personId))
    .leftJoin(company, eq(company.id, enrolment.companyId))
    .where(inArray(enrolment.state, ["enrolled", "pending"]))
    .orderBy(enrolment.id);

  /** Per account and sequencer: the keys to list, and the people's keys those do not cover. */
  const accounts = new Map<string, { sequencer: Sequencer; company: IdentityKey[]; people: Identity[] }>();

  for (const row of rows) {
    const who = personIdentity(row);
    const target = row.companyId ? asCandidate({ domain: row.companyDomain, externalId: row.companyExternalId, name: row.companyName }) : undefined;
    // The same verdict as enrolment's (0044): a domain that is not a host
    // fails closed, as it would have kept the company out.
    const standing = target ? protection.standing(target) : "clear";
    const byAddress = protection.person(who);
    if (standing === "clear" && !byAddress) continue;
    const why =
      standing === "protected"
        ? "its account is protected"
        : standing === "unreadable_key"
          ? `its company's domain is not a host that can be read: "${row.companyDomain}"`
          : "an address is on a protected domain";

    const suspendable = row as Suspendable;
    const r = await suspendEnrolment(deps, suspendable, who, ctx, REASON);
    const outcome =
      "suspended" in r
        ? "suspended; recorded with what the adapter returned as its read-back"
        : "notHeld" in r
          ? row.state === "pending"
            ? "the adapter answered that the provider holds nothing for it: left pending (decision 0060)"
            : "the adapter answered that the provider holds nothing for it"
          : "byAddress" in r
            ? "the adapter answered that it holds the person under no key of the kernel's, and returned a read-back for a stop by address: left pending (decision 0060); this report is the only record of that stop"
            : "would" in r
              ? `would ${r.would}`
              : `refused — the sequencer bound as "${r.refused.binding}": ${r.refused.answered}`;
    out.stops.push({ enrolment: row.id, sequenceKey: row.sequenceKey, state: row.state as "pending" | "enrolled", why, outcome });
    if ("refused" in r) {
      out.refused.push(`enrolment ${row.id} in "${row.sequenceKey}" (${why}): the sequencer bound as "${r.refused.binding}": ${r.refused.answered}${r.refused.retry ? "; running again is the remedy" : ""}`);
      continue;
    }

    // The account, as the provider can be asked to list it: the protected
    // domains this row fell under — wider than the host they matched, when
    // they are its ancestors — the company's own keys when it is the one
    // protected, and the person's keys those do not cover.
    const reach = reachFor(deps.registry, row);
    if ("refused" in reach) continue;
    const domains = new Set<string>();
    const companyKeys: IdentityKey[] = [];
    if (standing === "protected" && target) {
      for (const k of target.identity!.keys) {
        companyKeys.push(k);
        const under = k.kind === "domain" ? protection.domainOf(k.value) : undefined;
        if (under) domains.add(under);
        if (k.kind === "domain") domains.add(hostOf(k.value));
      }
    }
    for (const k of who.keys) {
      const under = k.kind === "email" ? protection.domainOf(k.value.split("@")[1] ?? "") : undefined;
      if (under) domains.add(under);
    }
    const account = `${reach.sequencer.provider}\n${standing === "protected" ? `company:${row.companyId}` : [...domains].sort().join(",")}`;
    const entry = accounts.get(account) ?? { sequencer: reach.sequencer, company: [], people: [] };
    for (const d of domains) if (!entry.company.some((k) => k.kind === "domain" && k.value === d)) entry.company.push({ kind: "domain", value: d });
    for (const k of companyKeys) if (k.kind !== "domain" && !entry.company.some((c) => c.kind === k.kind && c.value === k.value)) entry.company.push(k);
    const own = who.keys.filter((k) => !(k.kind === "email" && covered(hostOf(k.value.split("@")[1] ?? ""), [...domains])));
    if (own.length > 0) entry.people.push({ subject: "person", keys: own });
    accounts.set(account, entry);
  }

  for (const { sequencer, company: keys, people } of accounts.values()) {
    const through = `${CONTRACTS.sequencer} (${sequencer.provider})`;
    const targets: Identity[] = [...(keys.length > 0 ? [{ subject: "company" as const, keys }] : []), ...people];
    for (const target of targets) {
      const r = await sequencer.suppress({ idempotencyKey: keyOf(target), target, reason: REASON }, ctx);
      // `invalid` is the contract's answer for an identity with no key this
      // provider can act on: what `notApplicable` says of some keys, said of
      // all of them — a fact of the provider, not a write that failed. A
      // person known here by a profile id alone, at an email provider, is one.
      if (!r.ok && r.error.code === "invalid") {
        out.suppressions.push({ through, target: said(target.keys), outcome: `it can act on none of these keys: ${r.error.message}` });
        continue;
      }
      if (!r.ok) {
        const answered = `${r.error.code}: ${r.error.message}`;
        out.suppressions.push({ through, target: said(target.keys), outcome: `refused — ${answered}` });
        out.refused.push(`the suppression of ${said(target.keys)} through the sequencer bound as "${sequencer.provider}": ${answered}; running again is the remedy`);
        continue;
      }
      const listed = said(r.value.applied);
      const not = r.value.notApplicable.length > 0 ? `; it cannot act on ${said(r.value.notApplicable)}` : "";
      // What the adapter answered, as it answered it: the contract asks it to
      // read back what it lists, and the kernel cannot see whether it did.
      out.suppressions.push({ through, target: said(target.keys), outcome: `the adapter answered${ctx.dryRun ? ", in a dry run," : ""} that it applies ${listed || "nothing"}, as of ${r.value.asOf}${not}` });
    }
  }

  if (out.refused.length === 0 && !ctx.dryRun) {
    await deps.db
      .insert(protectionHeld)
      .values({ runId: ctx.runId, protectedAsOf: new Date(protection.asOf), accounts: protection.accounts })
      .onConflictDoNothing({ target: protectionHeld.runId });
    out.held = true;
  }
  return out;
}

/** The latest protected set a run held the promise against (0057), and when that run started, or nothing yet. */
export async function lastHeld(db: Database): Promise<{ runId: string; protectedAsOf: Date; startedAt: Date } | undefined> {
  const [row] = await db
    .select({ runId: protectionHeld.runId, protectedAsOf: protectionHeld.protectedAsOf, startedAt: runTable.startedAt })
    .from(protectionHeld)
    .innerJoin(runTable, eq(runTable.id, protectionHeld.runId))
    .orderBy(desc(protectionHeld.protectedAsOf))
    .limit(1);
  return row;
}

/**
 * How old a protected set was when a run started — not stored, read against
 * the run's own time (0057). A set its source dated after the run started is
 * fresher than the run needed, and said so, never as a negative age.
 */
export function ageAt(asOf: string | Date, startedAt: Date): string {
  const ms = startedAt.getTime() - new Date(asOf).getTime();
  if (ms < 0) return "computed after its run started";
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"} old when its run started` : "less than a minute old when its run started";
}

export interface StopProtectedRequest {
  /** How old the protected set may be, in minutes. Required, as for enrolment: no age is good enough by default. */
  protectedMaxAgeMinutes: number;
  dryRun: boolean;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
}

export interface StopProtectedReport {
  runId: string;
  /** When the run started, as `core.run` holds it: what the protected set's age is read against. */
  startedAt: Date;
  dryRun: boolean;
  status: "succeeded" | "failed";
  /** Why the act stopped, when it did. */
  stoppedBy?: string;
  /** Absent when protection could not be read. */
  act?: ProtectedStop;
}

/**
 * The command's run: protection read, the act, the run closed. A run of its
 * own, `acquisition.protected.stop`, so that how often the instance keeps the
 * promise is in the record, beside the enrolment runs that keep it too.
 */
export async function stopProtectedRun(
  deps: { db: Database; registry: Registry; now?: () => Date },
  request: StopProtectedRequest,
): Promise<StopProtectedReport> {
  const targets = deps.registry.get(CONTRACTS.targetList) as TargetList | undefined;
  if (!targets) throw new Error(`no adapter is bound to "${CONTRACTS.targetList}"`);
  if (!(request.protectedMaxAgeMinutes > 0)) throw new Error("protectedMaxAgeMinutes must be a positive number of minutes");

  const open = await openRun(deps.db, { processKey: "acquisition.protected.stop", trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const report: StopProtectedReport = { runId: open.id, startedAt: new Date(), dryRun: request.dryRun, status: "succeeded" };
  try {
    const [started] = await deps.db.select({ startedAt: runTable.startedAt }).from(runTable).where(eq(runTable.id, open.id));
    if (started) report.startedAt = started.startedAt;
    const acknowledged = await readAcknowledged(deps.db);
    const read = await readProtection(targets, { maxAgeMinutes: request.protectedMaxAgeMinutes, now: (deps.now ?? (() => new Date()))(), acknowledged }, open.context);
    if (read.ok) {
      report.act = await stopProtected(deps, read.protection, open.context);
      if (report.act.refused.length > 0) {
        report.stoppedBy = `protected accounts' enrolments could not all be stopped: ${report.act.refused.join("; ")}`;
      }
    } else {
      // Unreadable or stale: the act changes nothing (0057).
      report.stoppedBy = read.stop;
    }
  } catch (thrown) {
    await open.finish({ status: "failed", error: (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 500) }).catch(() => {});
    throw thrown;
  }
  if (report.stoppedBy) report.status = "failed";
  await open.finish(report.status === "succeeded" ? { status: "succeeded" } : { status: "failed", error: report.stoppedBy!.slice(0, 500) });
  return report;
}

/** The act as a person reads it, for both commands. */
export function describeStop(act: ProtectedStop, dryRun: boolean, startedAt?: Date): string[] {
  const age = startedAt ? `, ${ageAt(act.protectedAsOf, startedAt)}` : "";
  const lines = [`  the protected set: ${act.accounts} account${act.accounts === 1 ? "" : "s"}, computed ${act.protectedAsOf}${age}`];
  if (act.stops.length === 0) lines.push("  no running enrolment is at a protected account");
  for (const s of act.stops) lines.push(`  ${s.state} enrolment ${s.enrolment} in "${s.sequenceKey}" — ${s.why}: ${s.outcome}`);
  for (const s of act.suppressions) lines.push(`  suppression of ${s.target} through ${s.through}: ${s.outcome}`);
  if (act.unreached.length > 0) {
    lines.push(
      `  not reached: ${act.unreached.length} protected account${act.unreached.length === 1 ? "" : "s"} known by the target list's own identifier alone, which the registry records for no company — an enrolment at ${act.unreached.length === 1 ? "it" : "them"} is not found, and keeps running (decision 0068): ${act.unreached.map((a) => `${a.externalId}${a.name ? ` (${a.name})` : ""}`).join("; ")}`,
    );
  }
  if (dryRun) lines.push("  a dry run: nothing was written, and the promise is not recorded as held");
  else if (act.held) lines.push(`  the promise held as of ${act.protectedAsOf}, recorded in acquisition.protection_held`);
  else lines.push("  the promise did not hold: nothing recorded in acquisition.protection_held");
  return lines;
}
