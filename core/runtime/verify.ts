/**
 * core/runtime — is an instance's configuration real, or only plausible?
 *
 * A manifest can validate, every variable can be set, every adapter can load,
 * and the first real run can still fail — because the token is revoked, the
 * base URL is wrong, or the migrations were never applied. Only a round trip
 * tells those apart, so this makes one, the smallest there is:
 *
 *   1. boot — domains, manifest, bindings, credentials, every issue at once;
 *   2. open a run, in dry run, in the database the instance owns;
 *   3. probe each adapter that offers a probe (decision 0009);
 *   4. close the run with what happened, and say it.
 *
 * Dry run all the way: a probe is a read, and the context says no write may
 * happen even if an adapter were careless. The run row is the one thing it
 * writes, on purpose — a check nobody can see in the run log is a check
 * whose last result nobody can check.
 *
 * It ships from the kernel, as `kernel-verify`, for the reason decision 0005
 * gives for the instance check: a lesson learned in one instance reaches the
 * others through a version bump, not through a paste nobody repeats.
 */

import type { AdapterEnv } from "../contracts/types.js";
import { boot } from "./boot.js";
import { resolvePackage } from "./resolve.js";
import type { Database, OpenRun } from "./run.js";
import { openRun } from "./run.js";

export interface VerifyOptions {
  /** The instance root: where its manifest lives and its packages are installed. */
  root: string;
  /** Usually `process.env`, after the instance's `.env` was loaded. */
  env: AdapterEnv;
  /** Where the report goes, one line at a time. */
  say?: (line: string) => void;
}

interface Connection {
  db: Database;
  end(): Promise<void>;
}

/**
 * The instance's driver, not one the kernel picks (see `run.ts`): `pg` and
 * `drizzle-orm` are resolved from the instance root, as decision 0007 resolves
 * every name the instance chose. The kernel declares neither.
 */
async function connect(url: string, root: string): Promise<Connection> {
  let pg: { Client: new (config: { connectionString: string }) => { connect(): Promise<void>; end(): Promise<void> } };
  let drizzle: (client: unknown) => unknown;
  try {
    pg = ((await import(resolvePackage("pg", root))) as { default: typeof pg }).default;
    ({ drizzle } = (await import(resolvePackage("drizzle-orm/node-postgres", root))) as { drizzle: typeof drizzle });
  } catch (error) {
    throw new Error(
      `verify connects with this instance's own pg and drizzle-orm, and could not load them — ` +
        `add both to its dependencies (${(error as Error).message.split("\n")[0]})`,
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return { db: drizzle(client) as Database, end: () => client.end() };
}

/** Returns the exit code: 0 only when every step answered. */
export async function verify(options: VerifyOptions): Promise<number> {
  const say = options.say ?? ((line: string) => console.log(line));
  const shorten = (at: string) => at.replace(`${options.root.replace(/\/$/, "")}/`, "");

  /* 1. boot ------------------------------------------------------------- */

  const booted = await boot({ root: options.root, env: options.env });
  for (const issue of booted.issues) {
    say(`  ${issue.severity === "error" ? "✖" : "!"} ${shorten(issue.at)}\n      ${issue.message}`);
  }
  if (!booted.ok) {
    say(`\nboot: refused, ${booted.issues.length} issue(s). Nothing was opened or called.`);
    return 1;
  }
  say(`boot: ${booted.manifest.instance} — domains ${booted.domains.map((d) => d.name).join(", ")}`);
  for (const a of booted.registry.list()) say(`  ${a.contract} → ${a.provider} (${a.specifier})`);

  /* 2. open a run ------------------------------------------------------- */

  const url = options.env.DATABASE_URL;
  if (!url) {
    say("\nrun: DATABASE_URL is not set — boot is fine, but there is nowhere to record a run.");
    return 1;
  }

  let connection: Connection;
  try {
    connection = await connect(url, options.root);
  } catch (error) {
    say(`\nrun: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }

  let open: OpenRun;
  try {
    open = await openRun(connection.db, {
      processKey: "instance.verify",
      trigger: "cli",
      actor: { type: "system", id: "verify" },
      dryRun: true,
    });
  } catch (error) {
    // The driver's reason, not the query wrapper's: "relation does not exist"
    // is the useful line, and the ORM puts it in `cause`.
    const cause = (error as Error).cause;
    const why = cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0];
    say(`\nrun: cannot open one — ${why}`);
    say("     have the engine's migrations been applied to this database?");
    await connection.end();
    return 1;
  }
  say(`\nrun: ${open.id} opened, dry run`);

  /* 3. probe ------------------------------------------------------------ */

  const failures: string[] = [];
  const unprobed: string[] = [];
  try {
    for (const resolved of booted.registry.list()) {
      // Optional on the contract. Absent is reported as absent, never as
      // healthy: an adapter that was not asked has not answered.
      if (!resolved.adapter.probe) {
        say(`  ${resolved.contract}: ${resolved.provider} built, offers no probe`);
        unprobed.push(resolved.contract);
        continue;
      }
      const started = Date.now();
      const result = await resolved.adapter.probe(open.context);
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
  await connection.end();

  say(`run: ${open.id} closed, ${status}`);
  if (failures.length > 0) say("\nThis configuration is plausible, not real.");
  else if (unprobed.length > 0) say(`\nReal as far as it was probed. Not probed: ${unprobed.join(", ")}.`);
  else say("\nThis configuration is real.");
  return failures.length === 0 ? 0 : 1;
}
