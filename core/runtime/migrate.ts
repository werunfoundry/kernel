/**
 * core/runtime — installing the schemas an instance enables.
 *
 * Migrations are per layer, each with its own journal, applied in dependency
 * order (decision 0002): the core first, then each enabled domain after the
 * domains it depends on. Each layer's migrations are found where the instance
 * installed its package (0007), and recorded in a table of their own, so that
 * running this twice applies nothing the second time.
 *
 * It reads the manifest and the domains, and nothing else: no adapter is
 * built and no credential is needed. A schema is installed before a provider
 * is configured, not after.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";

import { loadDomain, readDocument } from "../manifest/load.js";
import type { DomainManifest, ValidationIssue } from "../manifest/types.js";
import { connect } from "./connect.js";
import type { Database } from "./run.js";
import { resolvePackage } from "./resolve.js";

export interface MigrateOptions {
  root: string;
  url: string;
  manifest?: string;
  say?: (line: string) => void;
}

const SCOPE = "@werunfoundry";

/** Enabled domains, each after everything it depends on. A cycle is refused. */
export function dependencyOrder(domains: readonly DomainManifest[]): { order: string[]; issues: ValidationIssue[] } {
  const byName = new Map(domains.map((d) => [d.name, d]));
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const issues: ValidationIssue[] = [];
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      issues.push({ severity: "error", at: "enabledDomains", message: `the domains depend on each other in a cycle: ${[...path, name].join(" → ")}` });
      return;
    }
    state.set(name, "visiting");
    for (const dep of byName.get(name)?.dependsOn ?? []) if (byName.has(dep)) visit(dep, [...path, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const d of [...domains].sort((a, b) => a.name.localeCompare(b.name))) visit(d.name, []);
  return { order, issues };
}

/**
 * How many of a layer's migrations the database has recorded: the rows of its
 * bookkeeping table, or none when the table does not exist yet. Read before
 * and after, so the command says what it did rather than that all is well.
 */
async function recorded(db: Database, layer: string): Promise<number> {
  const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
  const present = rowsOf(await db.execute(sql`select to_regclass(${`drizzle.__migrations_${layer}`}) is not null as present`));
  if (present[0]?.present !== true) return 0;
  const counted = rowsOf(await db.execute(sql`select count(*)::int as n from ${sql.identifier("drizzle")}.${sql.identifier(`__migrations_${layer}`)}`));
  return Number(counted[0]?.n ?? 0);
}

/** Returns the exit code. */
export async function migrate(options: MigrateOptions): Promise<number> {
  const say = options.say ?? ((line: string) => console.log(line));
  const file = `${options.root}/${options.manifest ?? "manifest.yaml"}`;

  const read = readDocument(file);
  if (read.result) {
    for (const i of read.result.issues) say(`  ✖ ${i.at}\n      ${i.message}`);
    return 1;
  }
  const enabled = (read.value as { enabledDomains?: unknown } | null)?.enabledDomains;
  if (!Array.isArray(enabled) || enabled.some((n) => typeof n !== "string")) {
    say(`  ✖ ${file}: enabledDomains is not a list of names`);
    return 1;
  }

  const issues: ValidationIssue[] = [];
  const domains: DomainManifest[] = [];
  for (const name of enabled as string[]) {
    try {
      const loaded = loadDomain(fileURLToPath(resolvePackage(`${SCOPE}/${name}/domain.yaml`, options.root)));
      issues.push(...loaded.issues);
      if (loaded.manifest) domains.push(loaded.manifest);
    } catch (error) {
      issues.push({ severity: "error", at: name, message: `cannot be found: ${(error as Error).message.split("\n")[0]}` });
    }
  }
  const { order, issues: cycle } = dependencyOrder(domains);
  issues.push(...cycle);
  for (const name of order) {
    for (const dep of domains.find((d) => d.name === name)?.dependsOn ?? []) {
      if (!order.includes(dep)) issues.push({ severity: "error", at: name, message: `depends on "${dep}", which is not enabled` });
    }
  }
  if (issues.some((i) => i.severity === "error")) {
    for (const i of issues) say(`  ✖ ${i.at}\n      ${i.message}`);
    say("\nmigrate: refused. Nothing was applied.");
    return 1;
  }

  let migrator: (db: unknown, config: { migrationsFolder: string; migrationsTable: string; migrationsSchema: string }) => Promise<void>;
  try {
    ({ migrate: migrator } = (await import(resolvePackage("drizzle-orm/node-postgres/migrator", options.root))) as {
      migrate: typeof migrator;
    });
  } catch (error) {
    say(`migrate: this instance's drizzle-orm has no migrator — ${(error as Error).message.split("\n")[0]}`);
    return 1;
  }

  let connection;
  try {
    connection = await connect(options.url, options.root, "migrate");
  } catch (error) {
    say(`migrate: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }

  try {
    for (const layer of ["core", ...order]) {
      const journal = resolvePackage(`${SCOPE}/${layer}/db/migrations/meta/_journal.json`, options.root);
      const folder = dirname(dirname(fileURLToPath(journal)));
      // One bookkeeping table per layer: a domain added later starts its own
      // count, and dropping a domain's schema leaves the others' untouched.
      const before = await recorded(connection.db, layer);
      await migrator(connection.db, { migrationsFolder: folder, migrationsTable: `__migrations_${layer}`, migrationsSchema: "drizzle" });
      const applied = (await recorded(connection.db, layer)) - before;
      say(
        applied > 0
          ? `  ${layer}: applied ${applied} migration${applied === 1 ? "" : "s"}`
          : `  ${layer}: nothing to apply, ${before} already applied`,
      );
    }
  } catch (error) {
    const cause = (error as Error).cause;
    say(`migrate: failed — ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
    return 1;
  } finally {
    await connection.end().catch(() => {});
  }
  say("\nmigrate: every enabled layer is installed.");
  return 0;
}
