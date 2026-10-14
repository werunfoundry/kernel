/**
 * core/runtime — the record that something happened.
 *
 * Every action this engine takes belongs to a run, and a run is a row. That
 * is the whole of doctrine 5: there are no users and no sessions, and the
 * question this system answers is "which run produced this", not "who was
 * logged in".
 *
 * It is also the only writer of `core.run`. A status set anywhere else is a
 * status nobody can trust.
 */

import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { CallContext } from "../contracts/types.js";
import { run as runTable } from "../db/schema.js";

/**
 * Any drizzle database, whichever driver the instance chose.
 *
 * The engine does not pick one. A library that reaches for a specific driver
 * decides its consumer's connection pooling, and that is not its decision to
 * make — an instance on a serverless platform and one on a long-lived process
 * need different answers.
 */
export type Database = PgDatabase<PgQueryResultHKT, any, any>;

export type Trigger = "webhook" | "cron" | "cli" | "manual";
export type ActorKind = "human" | "agent" | "system";
export type Outcome = "succeeded" | "partial" | "failed" | "cancelled";

export interface OpenRunInput {
  /** What is running, stable across runs: the index on `run` serves it. */
  processKey: string;
  trigger: Trigger;
  actor: { type: ActorKind; id?: string };
  /**
   * Recorded, not inferred. A dry run never followed by a real one is a fact
   * worth keeping — it is the difference between "we decided not to" and "we
   * forgot".
   */
  dryRun: boolean;
  /** The event that caused this, when there was one. */
  eventId?: string;
  signal?: AbortSignal;
}

export interface Finish {
  status: Outcome;
  /** Short and human. The detail belongs in logs, not in a column. */
  error?: string;
}

export interface OpenRun {
  id: string;
  /** Hand this to every adapter call, so each one is attributable. */
  context: CallContext;
  finish(outcome: Finish): Promise<void>;
}

/**
 * Open a run and get back the context every adapter call needs.
 *
 * Prefer `withRun` below. This exists for work that does not fit inside one
 * function, and it carries the obligation that comes with it: a run nobody
 * finishes stays `running` for ever, and anything counting stuck runs will
 * count it until a person goes looking.
 */
export async function openRun(db: Database, input: OpenRunInput): Promise<OpenRun> {
  const inserted = await db
    .insert(runTable)
    .values({
      processKey: input.processKey,
      trigger: input.trigger,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      eventId: input.eventId ?? null,
      dryRun: input.dryRun,
    })
    .returning({ id: runTable.id });

  const row = inserted[0];
  if (!row) {
    // An insert returning nothing is not a failure a caller can act on: it
    // means the database is not what this code believes it is.
    throw new Error("opening a run returned no row — is the core schema installed?");
  }

  let finished = false;

  return {
    id: row.id,
    context: {
      runId: row.id,
      actor:
        input.actor.id === undefined
          ? { type: input.actor.type }
          : { type: input.actor.type, id: input.actor.id },
      dryRun: input.dryRun,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    async finish(outcome: Finish): Promise<void> {
      // Finishing twice is a bug in the caller, and not a reason to overwrite
      // the first outcome — which is the one that was true.
      if (finished) return;
      finished = true;
      await db
        .update(runTable)
        .set({
          status: outcome.status,
          finishedAt: new Date(),
          error: outcome.error ?? null,
        })
        .where(eq(runTable.id, row.id));
    },
  };
}

/**
 * Do something inside a run, and close the row whatever happens.
 *
 * This is the form to use. An unhandled throw becomes `failed` with its
 * message; an abort becomes `cancelled`, because the caller asked for it and
 * calling that a failure makes every cancelled job look like an incident.
 * The error is then rethrown: the row is a record, not a catch.
 */
export async function withRun<T>(
  db: Database,
  input: OpenRunInput,
  work: (context: CallContext, open: OpenRun) => Promise<T>,
): Promise<T> {
  const open = await openRun(db, input);
  try {
    const result = await work(open.context, open);
    await open.finish({ status: "succeeded" });
    return result;
  } catch (thrown) {
    const aborted =
      (thrown instanceof Error && thrown.name === "AbortError") || input.signal?.aborted === true;
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    await open.finish({
      status: aborted ? "cancelled" : "failed",
      error: message.slice(0, 500),
    });
    throw thrown;
  }
}
