#!/usr/bin/env node
/**
 * kernel-enrol — the enrolment path (decision 0019), run from an instance's
 * root, usually as `pnpm enrol -- --sequence welcome --channel email --max-age 60`.
 *
 * A dry run unless `--live` is given: the safe mode is the one you get
 * without asking. `--max-age` (minutes) is required, because there is no
 * age at which the protected set is good enough by default.
 *
 *   --sequence <key>    the sequence, as the instance's bindings name it
 *   --channel <name>    a channel a bound sequencer takes
 *   --max-age <min>     how old the protected set may be
 *   --sender <id>       a sender whose capacity bounds the run; repeatable
 *   --limit <n>         how many candidate companies to read
 *   --from-run <id>     enrol the people this live sourcing run kept
 *                       (`kernel-source --live`), instead of finding people
 *   --list <key>        enrol the people of this sealed list, carrying the
 *                       messages the kernel wrote (decision 0064); with:
 *   --experiment <id>   the experiment whose approved drafts they carry
 *   --solicited         the person asked for it; without it the enrolment is
 *                       unsolicited, refused until the cap is judged ahead
 *   --reactive-within <min>  for a draft the reactive lane approved
 *   --live              actually enrol
 *
 * **The enrolment without messages stays, though 0064 rules it out.** Its
 * forms — from the target list, or `--from-run` — hand a person to a
 * sequence whose copy the provider holds. 0064 replaces them with `--list`,
 * whose enrolment carries the kernel's messages. They are removed with the
 * cap judged ahead over the whole plan (0064 §3), in the change that lifts
 * `--list`'s refusal of an unsolicited enrolment, and not before: until
 * then they are the only unsolicited enrolment there is.
 *
 * With `--from-run`, nobody that run did not keep is considered, and
 * protection, the opt-out and the registry are checked again here: what the
 * sourcing run decided is not trusted past the moment it was decided. The
 * two commands stay two on purpose — between them, a person reads the
 * sourcing report.
 *
 * Before anyone is enrolled, every enrolment already running at an account
 * protection now excludes is stopped (decision 0057); a run that cannot stop
 * them enrols nobody. That is not 0004's promise kept: it holds only as
 * often as this or `kernel-stop-protected` runs, and an instance that stops
 * enrolling stops withdrawing — schedule `kernel-stop-protected`.
 *
 * Provisionally, a live run is refused once an erasure has run on the
 * instance, until 0052's suppression register exists (below).
 *
 * Exits 0 when the run succeeded, 1 otherwise — a run that protection
 * stopped is not a success, even though it is the right outcome.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";

import { run } from "@werunfoundry/core/db/schema";
import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import { readDeclaration, type Sequencer } from "../contracts/sequencer.js";
import { CannotSuspend, CONTRACTS, enrol, ErasedWithoutRegister } from "../runtime/enrol.js";
import { describeStop, PROMISE } from "../runtime/protected.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const values = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const value = (name: string) => values(name)[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const sequenceKey = value("sequence");
  const channel = value("channel");
  const maxAge = Number(value("max-age"));
  if (!sequenceKey || !channel || !(maxAge > 0)) {
    console.log("enrol: --sequence, --channel and --max-age (minutes) are required.");
    return 1;
  }
  if (value("list") && !value("experiment")) {
    console.log("enrol: --list takes --experiment <id>: the experiment whose approved drafts the enrolment carries (decision 0064).");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nenrol: boot refused. Nothing was opened or called.");
    return 1;
  }
  // What the bound sequencer says it cannot do, and what stopping someone
  // costs through it (0051), before anyone is enrolled — and before the
  // database is reached, so a refusal needs nothing else to be read.
  const sequencer = booted.registry.forChannel<Sequencer>(CONTRACTS.sequencer, channel);
  if (sequencer) {
    const declared = readDeclaration(sequencer);
    for (const line of declared.lines) console.log(line);
    if (!declared.suspends) {
      console.log(`\nenrol: refused — ${declared.refusal}. Nobody was enrolled and no provider was called.`);
      return 1;
    }
    console.log("");
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("enrol: DATABASE_URL is not set — a run must be recorded.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "enrol");
  } catch (error) {
    console.log(`enrol: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    // PROVISIONAL — removed when the guard decision 0055 brings lands, and not
    // to be extended to anything else in the meantime. The one reader finds
    // an erased objector by the keys the erasure kept, and enrolment asks it;
    // the threshold is the passage's to hold, and 0055 removes this guard
    // with it, never before. The register would only ever hold people the
    // kernel erased, so a live run is refused once one has run here. It holds
    // only as long as those runs do: an erasure run deleted by hand reopens
    // it. Read by `run_process_started_at_idx`. The runtime refuses the same
    // (`ErasedWithoutRegister`), for every caller; this says it before
    // anything else is read, as 0051's refusal does.
    if (flag("live")) {
      const erased = await connection.db
        .select({ id: run.id })
        .from(run)
        .where(and(eq(run.processKey, "relations.person.erase"), eq(run.dryRun, false)))
        .limit(1);
      if (erased.length > 0) {
        console.log(
          "enrol: refused — an erasure has run on this instance, and the passage that holds the threshold is not built (decision 0055): " +
            "live enrolment stays refused until it is. Nobody was enrolled and no provider was called; a dry run is still allowed.",
        );
        return 1;
      }
    }
    const limit = Number(value("limit"));
    let report;
    try {
      report = await enrol(
      { db: connection.db, registry: booted.registry, identity: booted.identity, fingerprints: booted.fingerprints },
      {
        sequenceKey,
        channel,
        protectedMaxAgeMinutes: maxAge,
        dryRun: !flag("live"),
        trigger: "cli",
        actor: { type: "human" },
        ...(limit > 0 ? { query: { limit } } : {}),
        ...(value("from-run") ? { fromSourcingRun: value("from-run")! } : {}),
        ...(value("list")
          ? {
              fromList: {
                listKey: value("list")!,
                experimentId: value("experiment") ?? "",
                unsolicited: !flag("solicited"),
                ...(Number(value("reactive-within")) > 0 ? { reactiveWithinMinutes: Number(value("reactive-within")) } : {}),
              },
            }
          : {}),
        ...(values("sender").length ? { senders: values("sender").map((externalId) => ({ externalId })) } : {}),
      },
      );
    } catch (error) {
      if (error instanceof CannotSuspend || error instanceof ErasedWithoutRegister) {
        console.log(`enrol: refused — ${error.message}. Nobody was enrolled and no provider was called.`);
        return 1;
      }
      // Configuration or the database — not an outcome of the run, and never
      // a stack trace in place of a sentence.
      const cause = (error as Error).cause;
      console.log(`enrol: ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
      console.log("     have the engine's migrations been applied, and is every contract bound?");
      return 1;
    }

    // An address when there is one: a sourced person's first key is often a profile id.
    const shown = (p: { keys: { kind: string; value: string }[] }) => p.keys.find((k) => k.kind === "email")?.value ?? p.keys[0]?.value;
    const keyOf = (s: { person?: { keys: { kind: string; value: string }[] }; company: { domain?: string; name?: string } }) =>
      (s.person ? shown(s.person) : undefined) ?? s.company.domain ?? s.company.name ?? "?";
    console.log(`run: ${report.runId} — ${report.dryRun ? "dry run" : "live"} — ${report.status}`);
    if (report.stoppedBy) console.log(`  stopped: ${report.stoppedBy}`);
    console.log(`  protected accounts read: ${report.protectedAccounts} distinct, from ${report.protectedRows} rows`);
    // What each protected entry excluded in this run (0044): one excluding dozens is the first sign of a bad entry.
    if (report.protectionHits.length > 0) {
      console.log(`  protection excluded, by entry: ${report.protectionHits.map((h) => `${h.entry} (${h.candidates})`).join(", ")}`);
    }
    if (report.protection) {
      const p = report.protection;
      console.log(`    matched on ${p.surface.domains} domains and ${p.surface.companyIds} company ids; ${p.unkeyedRowsOfCoveredCustomers} rows with no key, of customers protected through another row`);
      if (p.uncovered.length > 0) {
        console.log(`    ! protected by nothing, acknowledged as uncovered: ${p.uncovered.length}`);
        for (const u of p.uncovered) console.log(`      - ${u.customerId}${u.name ? ` (${u.name})` : ""}: ${u.rows} row${u.rows === 1 ? "" : "s"}, no key`);
      }
    }
    // What the run's start did to enrolments already running at protected
    // accounts (0057) — and what that is not.
    if (report.protectedStop) {
      console.log("  before enrolling, the enrolments already running at protected accounts (decision 0057):");
      for (const line of describeStop(report.protectedStop, report.dryRun)) console.log(`  ${line}`);
      console.log(`    ${PROMISE}`);
    }
    console.log(
      `  capacity: ${report.capacity.checked ? `budget ${report.capacity.budget}` : `not checked — ${report.capacity.why}`}`,
    );
    console.log(`  ${report.dryRun ? "would enrol" : "enrolled"}: ${report.enrolled.length}`);
    for (const e of report.enrolled) console.log(`    + ${shown(e.person)} (${e.state})`);
    if (report.reconciled.length > 0) {
      console.log(`  reconciled, enrolled by an earlier run that stopped before recording it: ${report.reconciled.length}`);
      for (const e of report.reconciled) console.log(`    = ${shown(e.person)} (${e.state})`);
    }
    const reasons = ["protected", "unreadable_key", "opted_out", "suspended", "not_drafted", "refused", "capacity", "duplicate", "unreachable"] as const;
    for (const reason of reasons) {
      const these = report.skipped.filter((s) => s.reason === reason);
      if (these.length === 0) continue;
      console.log(`  skipped, ${reason}: ${these.length}`);
      for (const s of these) console.log(`    - ${keyOf(s)}: ${s.detail}`);
    }
    if (!report.recorded) console.log("  ! the run row could not be closed; this output is the only record of the run");
    return report.status === "succeeded" && report.recorded ? 0 : 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
