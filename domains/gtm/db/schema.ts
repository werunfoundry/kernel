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
  index,
  integer,
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
