/**
 * core/runtime — an experiment: recorded, then started, by a person (decision
 * 0072); its lane, and the streak that earns it autonomy.
 *
 * **Recorded** is `draft`: nothing is contacted for it. **Started** is
 * `running`: the act that authorises contact, which the message gate reads
 * for every approval. Each is its own run, with the person as its actor; the
 * row keeps no actor of its own. Leaving `running` is not decided (0072): no
 * function here does it.
 *
 * What an experiment needs before it starts is its domain's to say — the core
 * knows no template — so `startExperiment` asks the caller, inside the
 * transaction that holds the row.
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
import type { Database, Trigger } from "./run.js";
import { openRun } from "./run.js";

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

export interface ExperimentToRecord {
  slug: string;
  /** One of the experiment types the enabled domains declare. */
  type: string;
  /** What it tests, by reference: required, so no experiment is orphan work. */
  hypothesisRef: string;
  /** Said, never defaulted: the lane decides who approves what it sends. */
  lane: Lane;
  owner?: string;
}

/** The experiment as it is on record, or nothing. */
export async function findExperimentBySlug(db: Database, slug: string) {
  const [row] = await db
    .select({ id: experiment.id, slug: experiment.slug, type: experiment.type, status: experiment.status, lane: experiment.lane, hypothesisRef: experiment.hypothesisRef, owner: experiment.owner })
    .from(experiment)
    .where(eq(experiment.slug, slug.trim()));
  return row;
}

/** Why an experiment cannot be recorded as given, or nothing. Reads nothing. */
export function checkExperiment(input: ExperimentToRecord, declaredTypes: ReadonlySet<string>): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug)) return "a slug is lowercase letters, digits and dashes: it names the row, the provider object and the folder";
  if (!declaredTypes.has(input.type)) return `no enabled domain declares the experiment type "${input.type}"; declared: ${[...declaredTypes].sort().join(", ") || "none"}`;
  if (!input.hypothesisRef.trim()) return "an experiment names the hypothesis it tests";
  if (!["reviewed", "autonomous", "reactive"].includes(input.lane)) return `"${input.lane}" is not a lane: reviewed, autonomous or reactive`;
  return undefined;
}

/**
 * A person records an experiment, in `draft` (decision 0072). One already on
 * record under the slug is refused, never overwritten: the slug's uniqueness
 * is the DDL's.
 */
export async function recordExperiment(
  db: Database,
  input: ExperimentToRecord & { by: string; trigger: Trigger },
  declaredTypes: ReadonlySet<string>,
): Promise<{ runId: string; experimentId: string } | { refused: string }> {
  const by = input.by.trim();
  if (!by) return { refused: "who records it is required: recording an experiment is a person's act" };
  const wrong = checkExperiment(input, declaredTypes);
  if (wrong) return { refused: wrong };
  if (await findExperimentBySlug(db, input.slug)) return { refused: `an experiment ${input.slug} is already on record` };
  const open = await openRun(db, { processKey: "core.experiment.record", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const [row] = await db
      .insert(experiment)
      .values({ slug: input.slug, type: input.type, hypothesisRef: input.hypothesisRef.trim(), lane: input.lane, status: "draft", ...(input.owner ? { owner: input.owner } : {}) })
      .returning({ id: experiment.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, experimentId: row!.id };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/**
 * A person starts an experiment: `draft` to `running`, the act that
 * authorises contact (decision 0072). `ready` is the domain's say, asked
 * with the row locked: a reason it cannot start, or nothing.
 */
export async function startExperiment(
  db: Database,
  input: { slug: string; by: string; trigger: Trigger },
  ready: (tx: Database, experimentId: string) => Promise<string | undefined>,
): Promise<{ runId: string } | { refused: string }> {
  const by = input.by.trim();
  if (!by) return { refused: "who starts it is required: starting an experiment is a person's act" };
  const found = await findExperimentBySlug(db, input.slug);
  if (!found) return { refused: `no experiment ${input.slug} is on record` };
  const open = await openRun(db, { processKey: "core.experiment.start", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const refused = await db.transaction(async (tx) => {
      const [row] = await tx.select({ status: experiment.status }).from(experiment).where(eq(experiment.id, found.id)).for("update");
      if (row?.status !== "draft") return `the experiment is ${row?.status ?? "gone"}: only one in draft is started`;
      const notReady = await ready(tx, found.id);
      if (notReady) return notReady;
      await tx.update(experiment).set({ status: "running", updatedAt: new Date() }).where(eq(experiment.id, found.id));
      return undefined;
    });
    await open.finish(refused ? { status: "failed", error: refused.slice(0, 500) } : { status: "succeeded" });
    return refused ? { refused } : { runId: open.id };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
