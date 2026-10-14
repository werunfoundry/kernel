/**
 * core — governance. Contains no business word (doctrine 1).
 *
 * Four tables: what happened, what ran, what was decided, what is being tried.
 * Everything else comes from a domain.
 *
 * The core never references a domain. That is why `experiment.targets` is a
 * list of typed references rather than a foreign key: a foreign key into
 * `relations.audience` would make the bottom layer depend on the one above it
 * (doctrine 2).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const core = pgSchema("core");

/** Who or what produced a row. Attribution, not identity (doctrine 5). */
export const actorType = core.enum("actor_type", ["human", "agent", "system"]);

export const triggerKind = core.enum("trigger_kind", [
  "webhook",
  "cron",
  "cli",
  "manual",
]);

export const runStatus = core.enum("run_status", [
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

/**
 * How much human review this experiment requires. A property of the
 * experiment, never a global setting, so it cannot be forgotten under time
 * pressure.
 */
export const lane = core.enum("lane", ["reviewed", "autonomous", "reactive"]);

export const experimentStatus = core.enum("experiment_status", [
  "draft",
  "running",
  "measuring", // production stopped, measurement window still open
  "validated",
  "killed",
]);

/**
 * Something that happened, typed by a domain: `<domain>.<verb>`.
 *
 * One endpoint accepts these and routes to a process. The unique index is the
 * whole reason that endpoint is safe to expose: providers retry, and a retried
 * delivery must be a no-op rather than a second run.
 */
export const event = core.table(
  "event",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    kind: text("kind").notNull(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),

    payload: jsonb("payload").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null means not yet handled. The retry sweep reads exactly this. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("event_provider_event_uidx").on(t.provider, t.providerEventId),

    /** `listUnprocessedEvents` — the sweep that catches a failed trigger. */
    index("event_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

/**
 * One execution of a process. `processKey` is a string matching a process
 * declared in the manifest: processes are configuration, not rows.
 */
export const run = core.table(
  "run",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    processKey: text("process_key").notNull(),
    trigger: triggerKind("trigger").notNull(),
    status: runStatus("status").notNull().default("running"),

    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),

    eventId: uuid("event_id").references(() => event.id, { onDelete: "set null" }),

    /** A dry run that was never done is a fact worth recording. */
    dryRun: boolean("dry_run").notNull().default(false),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    /** `listRunsForProcess` on the health check, newest first. */
    index("run_process_started_at_idx").on(t.processKey, sql`${t.startedAt} desc`),
  ],
);

/**
 * An experiment, and the three fields whose absence makes a review a
 * judgement call with no inputs: a kill threshold, a budget, and a measurement
 * window distinct from the run dates.
 *
 * Its required parent is a hypothesis, which lives in the human-facing tool.
 * The reference is a URL rather than a foreign key on purpose: an empty table
 * here would be a maintenance cost with no return.
 */
export const experiment = core.table(
  "experiment",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** One slug names the row upstream, this row, the provider object, the folder. */
    slug: text("slug").notNull(),

    /**
     * Contributed by a domain, so text rather than an enum: a Postgres enum
     * cannot be extended by a domain without that domain migrating a type it
     * does not own. Validated against the manifest.
     */
    type: text("type").notNull(),

    status: experimentStatus("status").notNull().default("draft"),

    /** Required parent. Refusing a null here is what stops orphan work. */
    hypothesisRef: text("hypothesis_ref").notNull(),

    /** A handle resolved against instance configuration, not a user row. */
    owner: text("owner"),

    lane: lane("lane").notNull().default("reviewed"),

    /**
     * How a lane earns autonomy: consecutive approvals with no edit. It never
     * climbs by decree, and it drops back the moment an approved item is
     * edited before going out.
     */
    autonomyStreak: integer("autonomy_streak").notNull().default(0),

    /**
     * Typed references to what this experiment acts on, e.g.
     * `[{ kind: "relations.audience", id: "…" }]`. Not a foreign key: the core
     * does not depend on a domain (doctrine 2).
     */
    targets: jsonb("targets").notNull().default(sql`'[]'::jsonb`),

    metric: text("metric"),
    killThreshold: numeric("kill_threshold"),
    minimumSample: integer("minimum_sample"),
    budgetEur: numeric("budget_eur"),

    runStartsAt: timestamp("run_starts_at", { withTimezone: true }),
    runEndsAt: timestamp("run_ends_at", { withTimezone: true }),

    /**
     * Separate from the run dates: a change can ship in a day and be measured
     * weeks later. `baselineSnapshot` is taken at `measureStartsAt`, because a
     * source whose own window rolls destroys the comparison before the verdict
     * is due.
     */
    measureStartsAt: timestamp("measure_starts_at", { withTimezone: true }),
    measureEndsAt: timestamp("measure_ends_at", { withTimezone: true }),
    baselineSnapshot: jsonb("baseline_snapshot"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("experiment_slug_uidx").on(t.slug),

    /** `listExperimentsPastWindow`: status = measuring and measure_ends_at < now(). */
    index("experiment_measure_ends_at_idx").on(t.measureEndsAt),
  ],
);

/**
 * A decision and the number it rested on.
 *
 * This is the whole metrics story (doctrine 3). Rates are read from their
 * source when someone needs them; the only figures kept are those a decision
 * used, frozen at the moment it was taken.
 */
export const decision = core.table(
  "decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Polymorphic by design: a decision can be about anything, in any domain. */
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id"),

    choice: text("choice").notNull(),
    rationale: text("rationale"),

    /** As read at decision time. Never recomputed. */
    metricSnapshot: jsonb("metric_snapshot"),

    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),

    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `listDecisionsForSubject` on a debrief. */
    index("decision_subject_idx").on(t.subjectKind, t.subjectId),
  ],
);
