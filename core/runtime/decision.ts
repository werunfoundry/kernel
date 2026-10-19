/**
 * core/runtime — recording a decision (decision 0039).
 *
 * One line: on this date, this person concluded this, on this experiment,
 * having read these figures. A person's act, in its own run with the person
 * as actor; the schema refuses any other actor and any update. Nothing here
 * computes a conclusion or reads a figure: the readings are what the person
 * read, frozen as they were given.
 *
 * Not idempotent, on purpose (decision 0047): doctrine 4's uniqueness key is
 * for a write path that can replay — a retry, a redelivery — and the one
 * caller here is a person at a terminal, who concludes again when they run
 * it again. A path that can retry needs that key, and a migration, first.
 */

import { asc, eq } from "drizzle-orm";

import { decision, experiment } from "../db/schema.js";
import type { Database } from "./run.js";
import { openRun } from "./run.js";

/** One figure as it was read: which metric, its value, and when. */
export interface Reading {
  metric: string;
  value: number | null;
  readAt: string;
  [more: string]: unknown;
}

/**
 * The readings as given, or why they are not readings: a list, each with its
 * metric, a number or null, and the moment it was read. Kept as given, never
 * recomputed.
 */
export function checkReadings(given: unknown): { readings: Reading[] } | { refused: string } {
  if (!Array.isArray(given)) return { refused: "the readings are a list, empty when nothing was read" };
  for (const [i, r] of given.entries()) {
    const at = `reading ${i + 1}`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) return { refused: `${at} is not an object` };
    const { metric, value, readAt } = r as Record<string, unknown>;
    if (typeof metric !== "string" || metric.trim() === "") return { refused: `${at} names no metric` };
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return { refused: `${at}'s value is neither a number nor null` };
    if (typeof readAt !== "string" || Number.isNaN(new Date(readAt).getTime())) return { refused: `${at} does not say when it was read` };
  }
  return { readings: given as Reading[] };
}

/** An experiment by its slug, for a person who names it. Reads only. */
export async function findExperiment(db: Database, slug: string): Promise<{ id: string; slug: string; status: string } | undefined> {
  const [row] = await db.select({ id: experiment.id, slug: experiment.slug, status: experiment.status }).from(experiment).where(eq(experiment.slug, slug.trim()));
  return row;
}

/** The decisions on an experiment, oldest first, for a person to read before adding one. */
export async function listDecisions(db: Database, experimentId: string): Promise<{ conclusion: string; decidedBy: string; decidedAt: Date }[]> {
  return db
    .select({ conclusion: decision.conclusion, decidedBy: decision.actorId, decidedAt: decision.decidedAt })
    .from(decision)
    .where(eq(decision.experimentId, experimentId))
    .orderBy(asc(decision.decidedAt));
}

export async function recordDecision(
  db: Database,
  input: { experimentId: string; conclusion: string; rationale?: string; readings: Reading[]; by: string },
): Promise<{ runId: string; decisionId: string }> {
  const by = input.by.trim();
  const conclusion = input.conclusion.trim();
  if (by === "") throw new Error("who decided is required: a decision is a person's");
  if (conclusion === "") throw new Error("a decision concludes something");
  const checked = checkReadings(input.readings);
  if ("refused" in checked) throw new Error(checked.refused);
  const open = await openRun(db, { processKey: "core.decision.record", trigger: "manual", actor: { type: "human", id: by }, dryRun: false });
  try {
    const [row] = await db
      .insert(decision)
      .values({
        experimentId: input.experimentId,
        conclusion,
        ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
        readings: input.readings,
        actorType: "human",
        actorId: by,
        runId: open.id,
      })
      .returning({ id: decision.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, decisionId: row!.id };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
