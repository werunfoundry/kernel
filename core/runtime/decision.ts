/**
 * core/runtime — recording a decision (decision 0039).
 *
 * One line: on this date, this person concluded this, on this experiment,
 * having read these figures. A person's act, in its own run with the person
 * as actor; the schema refuses any other actor and any update. Nothing here
 * computes a conclusion or reads a figure: the readings are what the person
 * read, frozen as they were given.
 */

import { decision } from "../db/schema.js";
import type { Database } from "./run.js";
import { openRun } from "./run.js";

/** One figure as it was read: which metric, its value, and when. */
export interface Reading {
  metric: string;
  value: number | null;
  readAt: string;
  [more: string]: unknown;
}

export async function recordDecision(
  db: Database,
  input: { experimentId: string; conclusion: string; rationale?: string; readings: Reading[]; by: string },
): Promise<{ runId: string; decisionId: string }> {
  const by = input.by.trim();
  const conclusion = input.conclusion.trim();
  if (by === "") throw new Error("who decided is required: a decision is a person's");
  if (conclusion === "") throw new Error("a decision concludes something");
  if (!Array.isArray(input.readings)) throw new Error("the readings are a list, empty when nothing was read");
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
