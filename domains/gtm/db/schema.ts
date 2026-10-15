/**
 * gtm — acquisition. Depends on core and on relations (see domain.yaml).
 *
 * This domain is deliberately thin. Relations owns the record — people,
 * companies, sets, interactions, signals. What belongs here is what is
 * specific to producing outbound and handling what comes back: the approved
 * template, the rendered item waiting on its lane, and the acquisition state
 * of an entity relations owns.
 *
 * Note the two state tables. GTM does not add a column to `relations.person`,
 * because a domain never writes into another domain's entities (doctrine 2).
 * A one-to-one table in its own schema expresses the same thing and can be
 * dropped with the domain.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actorType, experiment, run } from "@werunfoundry/core/db/schema";
import { company, person } from "@werunfoundry/relations/db/schema";

export const gtm = pgSchema("gtm");

export const draftState = gtm.enum("draft_state", [
  "drafting",
  "awaiting_review",
  "approved",
  "dropped",
  "queued", // handed to the provider, not yet confirmed
  "sent",
  "failed",
]);

/**
 * The registry's own states for an enrolment — the engine's state machine,
 * so an enum (like `draft_state`), not the provider's view of the person,
 * which is read from the provider (doctrine 3).
 */
export const enrolmentState = gtm.enum("enrolment_state", [
  "pending", // written, the provider not yet heard back from: reconciled on the next run
  "enrolled", // the provider confirmed it
  "refused", // the provider refused it — invalid, or held under another key
]);

/** Why someone was not enrolled. Four, and never folded into one (0019). */
export const skipReason = gtm.enum("skip_reason", ["protected", "capacity", "duplicate", "unreachable", "opted_out"]);

export const lifecycleStage = gtm.enum("lifecycle_stage", [
  "unknown",
  "targeted",
  "engaged",
  "opportunity",
  "customer",
  "lost",
]);

/**
 * An approved template: one step of one variant of one sequence.
 *
 * Variant, step, persona and proof are decided in code before the model is
 * called; the model writes sentences and nothing else. That split is what
 * makes a bad generation recoverable — a parse failure cannot route someone
 * into the wrong follow-up sequence.
 *
 * Copy is data. A row here and a file in the instance, never a module in the
 * engine.
 */
export const message = gtm.table(
  "message",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiment.id, { onDelete: "cascade" }),

    variant: text("variant").notNull(),
    step: integer("step").notNull(),
    channel: text("channel").notNull(),

    angle: text("angle"),
    persona: text("persona"),
    subject: text("subject"),
    body: text("body").notNull(),

    /**
     * Keys of the manifest truths this message spends. A change to one flags
     * every message citing it — the drift check a prose context library has
     * never had.
     */
    truthsCited: text("truths_cited").array(),

    delayDays: integer("delay_days"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_experiment_variant_step_uidx").on(
      t.experimentId,
      t.variant,
      t.step,
    ),
  ],
);

/**
 * A rendered, personalised message waiting on its lane's approval, and the
 * source of truth for the review loop.
 *
 * It replaces the arrangement where a spreadsheet *was* the state, and where
 * a reviewer's judgement survived only in a file of dropped rows.
 *
 * Its gate is in the schema (decision 0027), not only in `runtime/draft.ts`:
 * a trigger allows only the moves forward — drafting to review or approved,
 * review to approved or dropped, approved to queued or dropped, queued to
 * sent or failed — and refuses any change to the rendered text once it is
 * approved, so what goes out is what was approved. The checks below make
 * every decision carry who took it, and every drop its reason.
 */
export const draft = gtm.table(
  "draft",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    experimentId: uuid("experiment_id")
      .notNull()
      .references(() => experiment.id, { onDelete: "cascade" }),

    /** Restrict: a person with work in flight is not quietly deleted. */
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),

    messageId: uuid("message_id").references(() => message.id, { onDelete: "set null" }),

    step: integer("step").notNull(),
    state: draftState("state").notNull().default("drafting"),

    renderedSubject: text("rendered_subject"),
    renderedBody: text("rendered_body"),

    /** Which identity this is queued against. Booked against the same capacity. */
    sender: text("sender"),

    /** The reviewer's judgement, durable. */
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    dropReason: text("drop_reason"),

    /**
     * True when a human changed the body before approving. This is what
     * breaks the lane's autonomy streak: a lane earns autonomy on approvals
     * that needed no correction, and loses it on the first that did.
     */
    editedBeforeApproval: boolean("edited_before_approval").notNull().default(false),

    actorType: actorType("actor_type").notNull().default("agent"),
    actorId: text("actor_id"),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One item per person per step per experiment. This is what makes
     * regenerating a batch safe, and why a crashed run reconciles on the next
     * pass instead of producing a second send.
     */
    uniqueIndex("draft_experiment_person_step_uidx").on(
      t.experimentId,
      t.personId,
      t.step,
    ),

    /** `listDraftsAwaitingReview`, oldest first. */
    index("draft_state_created_at_idx").on(t.state, t.createdAt),

    /** Past review, a draft says who decided and when — a human, or the lane. */
    check(
      "draft_decided",
      sql`${t.state} in ('drafting', 'awaiting_review') or (${t.decidedBy} is not null and ${t.decidedAt} is not null)`,
    ),
    /** A drop without a reason is a judgement nobody can learn from. */
    check("draft_dropped_has_reason", sql`${t.state} <> 'dropped' or ${t.dropReason} is not null`),
  ],
);

/**
 * Acquisition state of a person. One row per person, owned by this domain.
 * `relations.person` knows nothing about it.
 */
export const personState = gtm.table(
  "person_state",
  {
    personId: uuid("person_id")
      .primaryKey()
      .references(() => person.id, { onDelete: "cascade" }),

    lifecycleStage: lifecycleStage("lifecycle_stage").notNull().default("unknown"),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `listPeopleByStage` on the funnel view. */
    index("person_state_stage_idx").on(t.lifecycleStage),
  ],
);

/** Acquisition state of a company. Same rule as above. */
export const companyState = gtm.table(
  "company_state",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => company.id, { onDelete: "cascade" }),

    lifecycleStage: lifecycleStage("lifecycle_stage").notNull().default("unknown"),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }),

    /** Last interaction with anyone at this company, maintained by a trigger or a job. */
    lastTouchedAt: timestamp("last_touched_at", { withTimezone: true }),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("company_state_stage_idx").on(t.lifecycleStage),

    /** `listCompaniesUntouchedSince` — account pressure, newest first. */
    index("company_state_last_touched_idx").on(sql`${t.lastTouchedAt} desc nulls last`),
  ],
);

/**
 * The enrolment registry (decision 0026): one row per person per sequence,
 * answering "is this person enrolled, in which sequence, through which
 * company" from the database instead of from each provider in turn.
 *
 * Written before the provider is called. A run that dies between the two
 * leaves a `pending` row, and the next run reconciles it — asks the provider
 * whether the enrolment landed, and either confirms it or makes it, with the
 * key stored here — instead of enrolling the person a second time under a
 * new key.
 *
 * Which step a person is on is the provider's fact, read from it with this
 * row's reference; it is not copied here (doctrine 3).
 */
export const enrolment = gtm.table(
  "enrolment",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Restrict: a person with an enrolment on record is not quietly deleted. */
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),

    /**
     * The company the person was enrolled through. What makes "who at this
     * company is in a sequence" answerable when it becomes protected.
     * Attribution: losing the company keeps the enrolment.
     */
    companyId: uuid("company_id").references(() => company.id, { onDelete: "set null" }),

    /** The sequence as the instance declared it, and the channel it runs on. */
    sequenceKey: text("sequence_key").notNull(),
    channel: text("channel").notNull(),

    /**
     * The key the provider was given. Stored, so that a replay — or a
     * reconciliation after a crash — repeats it even if the person's keys
     * have grown in the meantime.
     */
    idempotencyKey: text("idempotency_key").notNull(),

    state: enrolmentState("state").notNull().default("pending"),
    /** The adapter that holds it, as it names itself. */
    provider: text("provider").notNull(),
    /** For `refused`: what the provider said. */
    refusal: text("refusal"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),

    /** Doctrine 5: the run that last wrote this row. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One enrolment per person per sequence — the sameness providers apply
     * too. It protects the write before the provider call: two runs racing on
     * one person write one row, and the loser reads it.
     */
    uniqueIndex("enrolment_person_sequence_uidx").on(t.personId, t.sequenceKey),

    /** `listEnrolledAt(companyId)` — who to withdraw when a company becomes protected. */
    index("enrolment_company_idx").on(t.companyId),

    /** `listPendingEnrolments` — what a crashed run left to reconcile. */
    index("enrolment_pending_idx").on(t.updatedAt).where(sql`${t.state} = 'pending'`),
  ],
);

/**
 * Every candidate a run did not enrol, and why (decision 0026). Before this,
 * the reasons existed only in the printed report (0019).
 *
 * Per run and append-only in use: a skip is an observation of that run, kept
 * for dry runs too, which is how a dry run can be read back. It names no
 * relations row — a protected person is not recorded as a person in order to
 * record that they were not contacted — so the subject is kept as it was
 * seen: the person's keys, or the company's.
 */
export const enrolmentSkip = gtm.table(
  "enrolment_skip",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Cascade: a skip is part of its run. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),

    sequenceKey: text("sequence_key").notNull(),
    channel: text("channel").notNull(),
    reason: skipReason("reason").notNull(),
    detail: text("detail").notNull(),

    /** The person's keys, when a person was skipped; absent when a whole company was. */
    person: jsonb("person"),
    /** The company as the target list gave it: domain, identifier, name. */
    company: jsonb("company").notNull(),

    /** What the skip is about, stable within a run: the enrolment key, or the company's. */
    subject: text("subject").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** A run that writes the same skip twice — a retried write — keeps one. */
    uniqueIndex("enrolment_skip_run_subject_uidx").on(t.runId, t.subject),

    /** `listSkipsForRun(runId, reason)` — reading a run back. */
    index("enrolment_skip_run_reason_idx").on(t.runId, t.reason),
  ],
);

/**
 * What a sourcing run did with each company and person it looked at
 * (decision 0031): kept, or excluded and why, in which pass.
 */
export const sourcingOutcome = gtm.enum("sourcing_outcome", [
  "kept",
  "protected",
  "known_to_crm",
  "opted_out",
  "duplicate",
  "incomplete",
  "unreachable",
  "not_reached",
  "simulated",
]);

/**
 * Every company and person a sourcing run looked at, and what it did with
 * each (decision 0031). The sourcing path's counterpart of `enrolment_skip`,
 * with the people it kept beside the ones it excluded: a later enrolment
 * reads the kept ones back by run, rather than sourcing — and paying — again.
 *
 * Per run and append-only in use, dry runs included. A kept person names the
 * relations row it was recorded as; a dry run records nobody, so its kept
 * rows name none. An excluded subject is kept as it was seen — its keys —
 * because a protected person is not recorded in order to record that they
 * were not contacted.
 */
export const sourcingResult = gtm.table(
  "sourcing_result",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Cascade: an outcome is part of its run. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),

    /** `company`: decided before anyone there was looked up. `person`: after. */
    pass: text("pass").notNull(),
    outcome: sourcingOutcome("outcome").notNull(),
    detail: text("detail").notNull(),

    /** The person's keys, when a person; absent when a whole company. */
    person: jsonb("person"),
    /** The company as the target list gave it: domain, identifier, name. */
    company: jsonb("company").notNull(),

    /** The recorded person, for a kept one in a live run. Restrict: a kept person is not quietly deleted from under the run that kept them. */
    personId: uuid("person_id").references(() => person.id, { onDelete: "restrict" }),

    /**
     * What the provider said about the keys the completion added, and what
     * each source charged, as the walk reported them. The run's own
     * observation, kept so a report can be read back; not a copy of a
     * provider's record.
     */
    said: jsonb("said"),
    cost: jsonb("cost"),

    /** What the outcome is about, stable within a run: the person's keys, or the company's. */
    subject: text("subject").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** A run that writes the same outcome twice — a retried write — keeps one. */
    uniqueIndex("sourcing_result_run_subject_uidx").on(t.runId, t.subject),

    /** `listKept(runId)` and `listExcluded(runId, outcome)` — reading a run back, and enrolling what it kept. */
    index("sourcing_result_run_outcome_idx").on(t.runId, t.outcome),

    check("sourcing_result_pass_check", sql`${t.pass} in ('company', 'person')`),
    /** A company-pass row is about a whole company: no person. */
    check("sourcing_result_company_pass_check", sql`${t.pass} = 'person' or ${t.person} is null`),
  ],
);
