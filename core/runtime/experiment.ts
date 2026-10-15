/**
 * core/runtime — an experiment's lane, and the streak that earns it autonomy.
 *
 * The only writer of `experiment.autonomy_streak` (decision 0027), the way
 * `run.ts` is the only writer of `run`. A domain that reviews work reports
 * each review here; it never sets the number.
 *
 * The streak counts consecutive human approvals that needed no edit. An edit,
 * or a drop — the work was not usable at all — sets it back to zero. Nothing
 * else moves it: it never climbs by decree, and an approval the lane gave
 * without a human is not a review.
 */

import { eq, sql } from "drizzle-orm";

import { experiment } from "../db/schema.js";
import type { Database } from "./run.js";

export type Lane = "reviewed" | "autonomous" | "reactive";

export interface LaneState {
  lane: Lane;
  autonomyStreak: number;
}

/**
 * The lane and streak, locked for the rest of the caller's transaction: two
 * reviews landing together must not both read the same streak.
 */
export async function laneOf(db: Database, experimentId: string): Promise<LaneState | undefined> {
  const [row] = await db
    .select({ lane: experiment.lane, autonomyStreak: experiment.autonomyStreak })
    .from(experiment)
    .where(eq(experiment.id, experimentId))
    .for("update");
  return row;
}

/** One human review of the experiment's work: clean, edited, or dropped. */
export async function recordReview(db: Database, experimentId: string, outcome: "clean" | "edited" | "dropped"): Promise<number> {
  const [row] = await db
    .update(experiment)
    .set({
      autonomyStreak: outcome === "clean" ? sql`${experiment.autonomyStreak} + 1` : 0,
      updatedAt: new Date(),
    })
    .where(eq(experiment.id, experimentId))
    .returning({ autonomyStreak: experiment.autonomyStreak });
  if (!row) throw new Error(`no experiment ${experimentId} to record a review on`);
  return row.autonomyStreak;
}
