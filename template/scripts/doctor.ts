/**
 * Is this instance's configuration real, or only plausible?
 *
 *   pnpm verify        (not `pnpm doctor`: that is a pnpm command of its own,
 *                       which runs instead of this and exits 0)
 *
 * A manifest can validate, every variable can be set, every adapter can load,
 * and the first real run can still fail — because the token is revoked, the
 * base URL is wrong, or the migrations were never applied. Only a round trip
 * tells those apart, so this makes one, the smallest there is:
 *
 *   1. boot — domains, manifest, bindings, credentials, every issue at once;
 *   2. open a run, in dry run, in the database the instance owns;
 *   3. call one read on each adapter it knows how to probe;
 *   4. close the run with what happened, and say it.
 *
 * Dry run all the way: a probe is a read, and the context says no write may
 * happen even if an adapter were careless. The run row is the one thing it
 * writes, on purpose — a doctor nobody can see in the run log is a doctor
 * whose last result nobody can check.
 *
 * Exits 0 only when every step answered.
 *
 * It runs on plain Node, against the published packages (decision 0008).
 * Inside the kernel's workspace those packages are TypeScript source and this
 * cannot run as it is; `pnpm try-instance` at the kernel root runs it the way
 * an instance would.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallContext, CallResult, Contract } from "@werunfoundry/core/contracts/types";
import { boot } from "@werunfoundry/core/runtime/boot";
import type { Database, OpenRun } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import type { Crm } from "@werunfoundry/relations/contracts/crm";

const root = join(import.meta.dirname, "..");

/**
 * One harmless read per contract this instance binds. A contract with no
 * entry is reported as built and not probed, which is true and not a failure.
 * The domains below are invented on purpose: a probe asks whether the provider
 * answers, not what it holds.
 */
const PROBES: Record<string, (adapter: Contract, ctx: CallContext) => Promise<CallResult<unknown>>> = {
  crm: (adapter, ctx) => (adapter as Crm).findCompanyByDomain("example.com", ctx),
};

const say = (line = "") => console.log(line);

async function main(): Promise<number> {
  // The same file `.env.example` tells the instance to fill. Absent is fine:
  // the variables may come from the environment the process was started in.
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  /* 1. boot ------------------------------------------------------------- */

  const booted = await boot({ root, env: process.env });
  for (const issue of booted.issues) {
    say(`  ${issue.severity === "error" ? "✖" : "!"} ${issue.at.replace(`${root}/`, "")}\n      ${issue.message}`);
  }
  if (!booted.ok) {
    say(`\nboot: refused, ${booted.issues.length} issue(s). Nothing was opened or called.`);
    return 1;
  }
  say(`boot: ${booted.manifest.instance} — domains ${booted.domains.map((d) => d.name).join(", ")}`);
  for (const a of booted.registry.list()) say(`  ${a.contract} → ${a.provider} (${a.specifier})`);

  /* 2. open a run ------------------------------------------------------- */

  const url = process.env.DATABASE_URL;
  if (!url) {
    say("\nrun: DATABASE_URL is not set — boot is fine, but there is nowhere to record a run.");
    return 1;
  }

  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    say(`\nrun: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }

  let open: OpenRun;
  try {
    open = await openRun(drizzle(client) as unknown as Database, {
      processKey: "instance.doctor",
      trigger: "cli",
      actor: { type: "system", id: "doctor" },
      dryRun: true,
    });
  } catch (error) {
    // The usual cause on a new instance, said in terms of what to do.
    // The driver's reason, not the query wrapper's: "relation does not exist"
    // is the useful line, and the ORM puts it in `cause`.
    const cause = (error as Error).cause;
    const why = cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0];
    say(`\nrun: cannot open one — ${why}`);
    say("     have the engine's migrations been applied to this database?");
    await client.end();
    return 1;
  }
  say(`\nrun: ${open.id} opened, dry run`);

  /* 3. call ------------------------------------------------------------- */

  const failures: string[] = [];
  try {
    for (const resolved of booted.registry.list()) {
      const probe = PROBES[resolved.contract];
      if (!probe) {
        say(`  ${resolved.contract}: built, no probe known for this contract`);
        continue;
      }
      const started = Date.now();
      const result = await probe(resolved.adapter, open.context);
      const ms = Date.now() - started;
      if (result.ok) {
        say(`  ${resolved.contract}: ${resolved.provider} answered in ${ms} ms`);
      } else {
        const e = result.error;
        say(`  ${resolved.contract}: ${resolved.provider} — ${e.code}${e.retryable ? " (retryable)" : ""}: ${e.message}`);
        failures.push(`${resolved.contract}: ${e.code}`);
      }
    }
  } catch (thrown) {
    // An adapter that throws broke the contract: results are returned, not
    // thrown. Recorded as such, and the run is still closed below.
    failures.push(`an adapter threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    say(`  ✖ ${failures.at(-1)}`);
  }

  /* 4. close ------------------------------------------------------------ */

  const status = failures.length === 0 ? "succeeded" : "failed";
  await open.finish(failures.length === 0 ? { status } : { status, error: failures.join("; ") });
  await client.end();

  say(`run: ${open.id} closed, ${status}`);
  say(failures.length === 0 ? "\nThis configuration is real." : "\nThis configuration is plausible, not real.");
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
