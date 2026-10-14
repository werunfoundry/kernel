/**
 * core/runtime — is an instance's configuration real, or only plausible?
 *
 * A manifest can validate, every variable can be set, every adapter can load,
 * and the first real run can still fail — because the token is revoked, the
 * base URL is wrong, or the migrations were never applied. Only a round trip
 * tells those apart, so this makes one, the smallest there is:
 *
 *   1. boot — domains, manifest, bindings, credentials, every issue at once;
 *   2. load the truths, which boot deliberately does not;
 *   3. open a run, in dry run, in the database the instance owns;
 *   4. probe each adapter that offers a probe (decision 0009);
 *   5. close the run with what happened, and say it.
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

import { join } from "node:path";

import type { AdapterEnv } from "../contracts/types.js";
import { loadTruths } from "../manifest/load.js";
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
  let pg: {
    Client: new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      end(): Promise<void>;
      on(event: "error", listener: (error: Error) => void): void;
    };
  };
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
  // A connection the server drops emits "error" outside any await. Without a
  // listener that is an uncaught exception, and the process dies with a stack
  // trace instead of a report. The failure itself surfaces where it matters:
  // in the query that needed the connection.
  client.on("error", () => {});
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

  /* 2. truths ----------------------------------------------------------- */

  // Not in boot, which answers "can this system run" — a truth nobody has
  // confirmed lately must not stop a run from being recorded. Here they are
  // part of the question: an invalid truth is configuration that is not
  // real. A stale one is a warning, as the validator says.
  const kinds = [...new Set(booted.domains.flatMap((d) => d.truthKinds ?? []))];
  const truths = loadTruths(join(options.root, booted.manifest.truthsDir), { knownKinds: kinds });
  for (const issue of truths.issues) {
    say(`  ${issue.severity === "error" ? "✖" : "!"} ${shorten(issue.at)}\n      ${issue.message}`);
  }
  const truthErrors = truths.issues.filter((i) => i.severity === "error").length;
  say(`truths: ${truths.truths.length} loaded${truthErrors ? `, ${truthErrors} refused` : ""}`);

  /* 3. open a run ------------------------------------------------------- */

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

  // From here a connection is open, and from the moment a run is opened, a
  // row says "running". Whatever happens below, the run is closed if it can
  // be and the connection is closed regardless — a run left "running" is
  // what openRun's own documentation warns about, and a stack trace is not a
  // report.
  let open: OpenRun | undefined;
  const failures: string[] = truthErrors ? [`truths: ${truthErrors} refused`] : [];
  const unprobed: string[] = [];
  let closed = false;
  try {
    try {
      open = await openRun(connection.db, {
        processKey: "instance.verify",
        trigger: "cli",
        actor: { type: "system", id: "verify" },
        dryRun: true,
      });
    } catch (error) {
      say(`\nrun: cannot open one — ${reason(error)}`);
      say("     have the engine's migrations been applied to this database?");
      return 1;
    }
    say(`\nrun: ${open.id} opened, dry run`);

    /* 4. probe ---------------------------------------------------------- */

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
  } finally {
    /* 5. close ---------------------------------------------------------- */

    if (open) {
      const status = failures.length === 0 ? "succeeded" : "failed";
      try {
        await open.finish(failures.length === 0 ? { status } : { status, error: failures.join("; ") });
        say(`run: ${open.id} closed, ${status}`);
        closed = true;
      } catch (error) {
        say(`run: ${open.id} could not be closed — ${reason(error)}`);
        say(`     its row still reads "running"; the outcome above is the only record of it`);
      }
    }
    await connection.end().catch(() => {});
  }

  if (!closed) {
    say("\nThis configuration could not be verified: its run was not recorded.");
    return 1;
  }
  if (failures.length > 0) say("\nThis configuration is plausible, not real.");
  else if (unprobed.length > 0) say(`\nReal as far as it was probed. Not probed: ${unprobed.join(", ")}.`);
  else say("\nThis configuration is real.");
  return failures.length === 0 ? 0 : 1;
}

/**
 * The driver's reason, not the query wrapper's: "relation does not exist" is
 * the useful line, and the ORM puts it in `cause`.
 */
function reason(error: unknown): string {
  const cause = (error as Error)?.cause;
  if (cause instanceof Error) return cause.message;
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}
