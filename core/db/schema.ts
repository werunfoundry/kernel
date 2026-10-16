/**
 * core — governance. Contains no business word (doctrine 1).
 *
 * Four tables: what was observed, what ran, what was concluded, what is being
 * tried.
 * Everything else comes from a domain.
 *
 * The core never references a domain. That is why `experiment.targets` is a
 * list of typed references rather than a foreign key: a foreign key into
 * `relations.audience` would make the bottom layer depend on the one above it
 * (doctrine 2).
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
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
 * Something observed, typed by a domain: `<domain>.<verb>` (decision 0039).
 *
 * Appended, never updated — a trigger refuses it. Whether an event was
 * handled is a run that names it (`run.event_id`), not a column that
 * changes. Written only through `recordEvent` (`runtime/event.ts`), which
 * refuses a type no enabled domain declares.
 *
 * The subject is in the payload: the core references no domain, so the
 * person-level trace is a touch written beside the event (0017).
 */
export const event = core.table(
  "event",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    kind: text("kind").notNull(),
    /** The source, as its adapter names itself. With the source's own id, the key. */
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),

    payload: jsonb("payload").notNull(),

    /** When it happened at the source — what a measurement window is about. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

    /** The run that read it. Restrict: the reading is the evidence the event was seen. */
    runId: uuid("run_id")
      .notNull()
      .references((): AnyPgColumn => run.id, { onDelete: "restrict" }),
  },
  (t) => [
    /**
     * Sources deliver at least once (0017): an event read twice is stored
     * once. Protects `recordEvent`, and the replay of a page after a crash.
     */
    uniqueIndex("event_provider_event_uidx").on(t.provider, t.providerEventId),

    /** `listEvents(kind, from, to)` — what a measurement window reads. */
    index("event_kind_occurred_at_idx").on(t.kind, t.occurredAt),
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
     * does not own. Validated against the manifest once a write path exists.
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
 * A decision (decision 0039): on this date, this person concluded this, on
 * this experiment, having read these figures. One line, written by a person,
 * never computed, never edited — a trigger refuses an update, and a check
 * any actor but a person.
 *
 * This is the whole metrics story (doctrine 3). Rates are read from their
 * source when someone needs them; the only figures kept are those a decision
 * rested on, frozen as they were read.
 */
export const decision = core.table(
  "decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Restrict: an experiment with a decision on it is not quietly deleted. */
    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiment.id, { onDelete: "restrict" }),

    /** What was concluded, in the person's words. */
    conclusion: text("conclusion").notNull(),
    rationale: text("rationale"),

    /** The figures it rested on, as they were read — each with its metric and when. Never recomputed. */
    readings: jsonb("readings").notNull(),

    /** Doctrine 5. A person, always: the check below. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    /** Restrict: the run that recorded it is the evidence. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),

    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `listDecisions(experimentId)` on a debrief. */
    index("decision_experiment_idx").on(t.experimentId, t.decidedAt),

    check("decision_human_check", sql`${t.actorType} = 'human'`),
    check("decision_readings_check", sql`jsonb_typeof(${t.readings}) = 'array'`),
  ],
);
