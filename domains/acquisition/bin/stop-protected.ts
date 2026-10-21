#!/usr/bin/env node
/**
 * kernel-stop-protected — stop every enrolment still running at an account
 * that became protected (decision 0057), run from an instance's root.
 *
 *   kernel-stop-protected --max-age <min>                       dry run: whom it would stop
 *   kernel-stop-protected --max-age <min> --live                suspend, suppress, record
 *   kernel-stop-protected --max-age <min> --live --scheduled    the same, recorded as the schedule's
 *
 * **0004's promise is kept only as often as this, or an enrolment run, runs.**
 * Between two runs, an account that became protected keeps receiving every
 * step its sequences send. An enrolment run does the same at its start, but
 * only when someone enrols: an instance that stops enrolling stops
 * withdrawing. So the instance schedules this command, at the rate it
 * chooses; the kernel does not choose that rate and does not claim it. Each
 * live run that met no refusal records the protected set it held the promise
 * against, and the latest is how far the promise is known to hold.
 *
 * `--max-age` (minutes) is required: no age of the protected set is good
 * enough by default, and a stale one changes nothing. A dry run unless
 * `--live` is given.
 *
 * Exits 0 when every protected enrolment it found was stopped, 1 otherwise.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import { ageAt, describeStop, lastHeld, PROMISE, stopProtectedRun } from "../runtime/protected.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const maxAge = Number(value("max-age"));
  if (!(maxAge > 0)) {
    console.log("stop-protected: --max-age (minutes) is required: how old the protected set may be.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nstop-protected: boot refused. Nothing was opened or called.");
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("stop-protected: DATABASE_URL is not set — a run must be recorded.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "stop-protected");
  } catch (error) {
    console.log(`stop-protected: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const before = await lastHeld(connection.db);
    let report;
    try {
      report = await stopProtectedRun(
        { db: connection.db, registry: booted.registry },
        { protectedMaxAgeMinutes: maxAge, dryRun: !flag("live"), trigger: flag("scheduled") ? "cron" : "cli", actor: { type: flag("scheduled") ? "system" : "human" } },
      );
    } catch (error) {
      const cause = (error as Error).cause;
      console.log(`stop-protected: ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
      console.log("     have the engine's migrations been applied, and is every contract bound?");
      return 1;
    }

    console.log(`run: ${report.runId} — ${report.dryRun ? "dry run" : "live"} — ${report.status}`);
    if (report.stoppedBy) console.log(`  stopped: ${report.stoppedBy}`);
    if (report.act) for (const line of describeStop(report.act, report.dryRun, report.startedAt)) console.log(line);
    console.log(
      before
        ? `  before this run, the promise was last known to hold as of ${before.protectedAsOf.toISOString()} (run ${before.runId}, its protected set ${ageAt(before.protectedAsOf, before.startedAt)})`
        : "  before this run, no run had recorded the promise as held",
    );
    console.log(`\n${PROMISE}`);
    return report.status === "succeeded" ? 0 : 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
