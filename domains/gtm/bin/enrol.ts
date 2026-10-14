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
 *   --live              actually enrol
 *
 * Exits 0 when the run succeeded, 1 otherwise — a run that protection
 * stopped is not a success, even though it is the right outcome.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import { enrol } from "../runtime/enrol.js";

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

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nenrol: boot refused. Nothing was opened or called.");
    return 1;
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
    const limit = Number(value("limit"));
    let report;
    try {
      report = await enrol(
      { db: connection.db, registry: booted.registry, identity: booted.identity },
      {
        sequenceKey,
        channel,
        protectedMaxAgeMinutes: maxAge,
        dryRun: !flag("live"),
        trigger: "cli",
        actor: { type: "human" },
        ...(limit > 0 ? { query: { limit } } : {}),
        ...(values("sender").length ? { senders: values("sender").map((externalId) => ({ externalId })) } : {}),
      },
      );
    } catch (error) {
      // Configuration or the database — not an outcome of the run, and never
      // a stack trace in place of a sentence.
      const cause = (error as Error).cause;
      console.log(`enrol: ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
      console.log("     have the engine's migrations been applied, and is every contract bound?");
      return 1;
    }

    const keyOf = (s: { person?: { keys: { value: string }[] }; company: { domain?: string; name?: string } }) =>
      s.person?.keys[0]?.value ?? s.company.domain ?? s.company.name ?? "?";
    console.log(`run: ${report.runId} — ${report.dryRun ? "dry run" : "live"} — ${report.status}`);
    if (report.stoppedBy) console.log(`  stopped: ${report.stoppedBy}`);
    console.log(`  protected accounts read: ${report.protectedAccounts}`);
    console.log(
      `  capacity: ${report.capacity.checked ? `budget ${report.capacity.budget}` : `not checked — ${report.capacity.why}`}`,
    );
    console.log(`  ${report.dryRun ? "would enrol" : "enrolled"}: ${report.enrolled.length}`);
    for (const e of report.enrolled) console.log(`    + ${e.person.keys[0]?.value} (${e.state})`);
    const reasons = ["protected", "capacity", "duplicate", "unreachable"] as const;
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
