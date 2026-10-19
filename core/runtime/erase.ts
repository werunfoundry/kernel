/**
 * core/runtime — erasing a subject (decision 0040).
 *
 * Not a cascade. Each domain declares, for each of its tables that names the
 * subject, what erasure does there — delete, empty listed columns, or keep
 * under a stated legal basis — and the core carries out the answers: the
 * domains from the top of the dependency order down, and in each, the
 * subject's own row last. That row is deleted, or, when a kept row elsewhere
 * still points at it, emptied of the columns its domain lists. One subject,
 * one transaction, one run with a person as actor.
 *
 * The core names no domain and no table here: everything it touches comes
 * from the declarations of the enabled domains, whose names and columns are
 * identifiers by validation.
 */

import { sql } from "drizzle-orm";

import type { DomainManifest, ErasureRule } from "../manifest/types.js";
import type { Database, Trigger } from "./run.js";
import { openRun } from "./run.js";

export interface ErasureStep {
  domain: string;
  table: string;
  column: string;
  do: ErasureRule["do"];
  /** Rows naming the subject, before anything was done. */
  rows: number;
  basis?: string;
  /** For the subject's own row: deleted, or emptied because a kept row still names it. */
  outcome?: "deleted" | "emptied" | "kept" | "none";
}

/** Upper domains first: a domain is erased before every domain it depends on. */
function order(domains: readonly DomainManifest[]): DomainManifest[] {
  const byName = new Map(domains.map((d) => [d.name, d]));
  const done = new Set<string>();
  const out: DomainManifest[] = [];
  const visit = (d: DomainManifest) => {
    if (done.has(d.name)) return;
    done.add(d.name);
    for (const dep of d.dependsOn) if (byName.has(dep)) visit(byName.get(dep)!);
    out.push(d);
  };
  for (const d of domains) visit(d);
  return out.reverse();
}

/** Within a domain, the subject's own row — a rule on `id` — after every other. */
const steps = (domains: readonly DomainManifest[]) =>
  order(domains).flatMap((d) =>
    [...(d.erasure ?? [])].sort((a, b) => Number(a.column === "id") - Number(b.column === "id")).map((rule) => ({ schema: d.schema, domain: d.name, rule })),
  );

const target = (schema: string, table: string) => sql`${sql.identifier(schema)}.${sql.identifier(table)}`;

async function count(db: Database, schema: string, rule: ErasureRule, id: string): Promise<number> {
  // The driver's result is the instance's (0010); node-postgres gives `rows`.
  const r = (await db.execute(sql`select count(*)::int as n from ${target(schema, rule.table)} where ${sql.identifier(rule.column)} = ${id}`)) as unknown as { rows: { n: number }[] };
  return Number(r.rows[0]!.n);
}

/** What erasing the subject would do, domain by domain. Reads only. */
export async function planErasure(db: Database, domains: readonly DomainManifest[], subjectId: string): Promise<ErasureStep[]> {
  const plan: ErasureStep[] = [];
  for (const { schema, domain, rule } of steps(domains)) {
    plan.push({ domain, table: rule.table, column: rule.column, do: rule.do, rows: await count(db, schema, rule, subjectId), ...(rule.do === "keep" ? { basis: rule.basis } : {}) });
  }
  return plan;
}

/**
 * Carries the plan out, as a person's run. All of it, or none of it. The caller
 * says how the run was reached (decision 0048).
 */
export async function erase(
  db: Database,
  domains: readonly DomainManifest[],
  input: { subjectId: string; by: string; processKey: string; trigger: Trigger },
): Promise<{ runId: string; steps: ErasureStep[] }> {
  const by = input.by.trim();
  if (by === "") throw new Error("who erases is required: erasing is a person's act");
  const open = await openRun(db, { processKey: input.processKey, trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const done = (await db.transaction(async (tx) => {
      const out: ErasureStep[] = [];
      for (const { schema, domain, rule } of steps(domains)) {
        const rows = await count(tx, schema, rule, input.subjectId);
        const step: ErasureStep = { domain, table: rule.table, column: rule.column, do: rule.do, rows, ...(rule.do === "keep" ? { basis: rule.basis } : {}) };
        const where = sql`${sql.identifier(rule.column)} = ${input.subjectId}`;
        if (rule.do === "delete" && rule.column === "id" && rule.ifStillNamed) {
          // Its own row: deleted, unless a kept row still points at it.
          step.outcome = rows === 0 ? "none" : "deleted";
          if (rows > 0) {
            try {
              await tx.transaction(async (sp) => {
                await sp.execute(sql`delete from ${target(schema, rule.table)} where ${where}`);
              });
            } catch (error) {
              if ((error as { cause?: { code?: string }; code?: string }).cause?.code !== "23503" && (error as { code?: string }).code !== "23503") throw error;
              const set = sql.join(rule.ifStillNamed.map((c) => sql`${sql.identifier(c)} = null`), sql`, `);
              await tx.execute(sql`update ${target(schema, rule.table)} set ${set} where ${where}`);
              step.outcome = "emptied";
            }
          }
        } else if (rule.do === "delete") {
          await tx.execute(sql`delete from ${target(schema, rule.table)} where ${where}`);
        } else if (rule.do === "anonymise") {
          const set = sql.join(rule.columns.map((c) => sql`${sql.identifier(c)} = null`), sql`, `);
          await tx.execute(sql`update ${target(schema, rule.table)} set ${set} where ${where}`);
        } else {
          step.outcome = "kept";
        }
        out.push(step);
      }
      return out;
    })) as ErasureStep[];
    await open.finish({ status: "succeeded" });
    return { runId: open.id, steps: done };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
