/**
 * acquisition — acquisition. Depends on core and on relations (see domain.yaml).
 *
 * This domain is deliberately thin. Relations owns the record — people,
 * companies, sets, interactions, signals. What belongs here is what is
 * specific to producing outbound and handling what comes back: the approved
 * template, the rendered item waiting on its lane, and the acquisition state
 * of an entity relations owns.
 *
 * Note the two state tables. This domain does not add a column to `relations.person`,
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

export const acquisition = pgSchema("acquisition");

export const draftState = acquisition.enum("draft_state", [
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
export const enrolmentState = acquisition.enum("enrolment_state", [
  "pending", // written, the provider not yet heard back from: reconciled on the next run
  "enrolled", // the adapter answered that the person is in the sequence; 0051 requires it to have read that back before saying so
  "refused", // the provider refused it — invalid, or held under another key
  /**
   * The kernel stopped this person in this sequence (decision 0051). Reached
   * from `enrolled` only, and terminal: resuming would contact again someone
   * the kernel decided to stop, which is a new enrolment decided anew. The
   * migration's trigger refuses every other move, whoever writes the row.
   *
   * Reached from `enrolled`, or from `pending` under a person's attestation
   * only (decision 0060): a pending row a read-back confirms, by its key,
   * goes through `enrolled`; a person's word never writes it.
   *
   * What it does not reach: an erased person found again. Erasure suspends
   * every enrolment a provider may hold, then anonymises the rows (decisions
   * 0053, 0056), suspended ones included: the row stays, naming nobody. A
   * later run that finds them records a new person, for whom the registry
   * holds no row, and nothing here refuses enrolling them in the same
   * sequence again; 0052's register will, once 0055's reader reads it.
   */
  "suspended",
]);

/**
 * What the enrolment records of the way out after the body (decision 0067
 * §3): three states, each a fact written once, none presumed.
 *
 * - `written` — the line, with the provider's link, written after the upload
 *   and read back at `way_out_read_back_at`. **Read back is the provider's
 *   record, not the message delivered**, which has twice been shown to
 *   differ: `written` says the line was written and read back at that time,
 *   never that the person received it. Whether the first step left before
 *   the read-back is what the touches pull's time of that step establishes,
 *   against this one (0067 §3); there is no column for it.
 * - `cut` — the instance cut the way out (0065 §2), and why.
 * - `absent` — none was written, and why: the adapter offers none or says
 *   nothing, the instance declares no line (0069), or the rewrite failed.
 *   The person stays enrolled: an absence is recorded, not refused.
 */
export const wayOutState = acquisition.enum("way_out", ["written", "cut", "absent"]);

/**
 * Why someone was not enrolled. Never folded into one (0019). A company whose
 * domain is not a host is `unreadable_key`, not `protected` (0044).
 */
export const skipReason = acquisition.enum("skip_reason", [
  "protected",
  "capacity",
  "duplicate",
  "unreachable",
  "opted_out",
  "unreadable_key",
  // Suspended from this sequence (0051): not a duplicate, which would make
  // every reading by reason wrong. See `enrolment_state.suspended` for what
  // this does not reach.
  "suspended",
  // Enrolled from a list, carrying the kernel's messages (0064): no approved
  // draft for every step of the sequence, so nothing to carry.
  "not_drafted",
  // The message gate refused a step's message (0038), so nobody is reached.
  "refused",
  // The cap, judged ahead over the whole plan (0064 §3), would be passed.
  "capped",
  // Recorded at no company with a domain or an id on a network (0044):
  // protection cannot judge the account. Not `protected`, which says
  // something matched, nor `unreachable`.
  "no_key",
]);

/**
 * The stages of the addressing motion, and only those (decision 0036). Being
 * a customer, or a former one, is true whether or not anyone prospects: it is
 * `relations.relationship`. There is no `unknown`: a subject nobody declared
 * a stage for has no row.
 */
export const lifecycleStage = acquisition.enum("lifecycle_stage", ["targeted", "engaged", "opportunity"]);

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
 *
 * A template, not a message: it has no recipient. What is sent to a person
 * is `relations.message` (decision 0038).
 */
export const template = acquisition.table(
  "template",
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
     * Keys of the manifest truths this template spends. A change to one flags
     * every template citing it — the drift check a prose context library has
     * never had.
     */
    truthsCited: text("truths_cited").array(),

    delayDays: integer("delay_days"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_experiment_variant_step_uidx").on(
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
export const draft = acquisition.table(
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

    templateId: uuid("template_id").references(() => template.id, { onDelete: "set null" }),

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
    /** Why the hand-over failed, for a `failed` draft (decision 0050). */
    failureReason: text("failure_reason"),

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
    /** A failure without a reason cannot be retried or learnt from either. */
    check("draft_failed_has_reason", sql`${t.state} <> 'failed' or ${t.failureReason} is not null`),
  ],
);

/**
 * The stage a person reached in the addressing motion, declared by a person
 * (decision 0036). One row per declaration, appended and never updated — a
 * trigger refuses it — so where someone stood when an experiment reached them
 * can be read back. The current stage is the latest by `at`, through
 * `person_state_current`, the view this domain publishes. `relations.person`
 * knows nothing about it (doctrine 2).
 */
export const personState = acquisition.table(
  "person_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Cascade: a stage is about its subject. */
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "cascade" }),

    stage: lifecycleStage("stage").notNull(),
    /** When it became true, as the person says. When it was written is `createdAt`. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),

    /** Doctrine 5. A person, always: the check below refuses anything else. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    /** Restrict: the run that declared it is the evidence. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("person_state_human_check", sql`${t.actorType} = 'human'`),

    /** `declareStage` replayed — same person, stage and moment — keeps one row. */
    uniqueIndex("person_state_declared_uidx").on(t.personId, t.stage, t.at),

    /** `person_state_current` — the latest declaration per person. */
    index("person_state_person_at_idx").on(t.personId, sql`${t.at} desc`),
  ],
);

/** The same, for a company. */
export const companyState = acquisition.table(
  "company_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    companyId: uuid("company_id")
      .notNull()
      .references(() => company.id, { onDelete: "cascade" }),

    stage: lifecycleStage("stage").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),

    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("company_state_human_check", sql`${t.actorType} = 'human'`),

    /** `declareStage` replayed keeps one row. */
    uniqueIndex("company_state_declared_uidx").on(t.companyId, t.stage, t.at),

    /** `company_state_current`. */
    index("company_state_company_at_idx").on(t.companyId, sql`${t.at} desc`),
  ],
);

/**
 * The views this domain publishes of each subject's current stage: its latest
 * declaration by `at`, the latest written breaking a tie. Another domain
 * reads a stage here, never in the tables (doctrine 2).
 */
export const personStateCurrent = acquisition
  .view("person_state_current", {
    personId: uuid("person_id").notNull(),
    stage: lifecycleStage("stage").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
  })
  .as(sql`select distinct on (person_id) person_id, stage, at, reason, actor_id from acquisition.person_state order by person_id, at desc, created_at desc`);

export const companyStateCurrent = acquisition
  .view("company_state_current", {
    companyId: uuid("company_id").notNull(),
    stage: lifecycleStage("stage").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
  })
  .as(sql`select distinct on (company_id) company_id, stage, at, reason, actor_id from acquisition.company_state order by company_id, at desc, created_at desc`);

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
export const enrolment = acquisition.table(
  "enrolment",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Restrict: a person with an enrolment on record is not quietly deleted.
     * Empty once the person is erased (0053): the row is then history.
     */
    personId: uuid("person_id").references(() => person.id, { onDelete: "restrict" }),

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

    /**
     * What an enrolment that carries the kernel's messages commits to
     * (decision 0064): each step, how long after the one before it leaves,
     * the message it carries, and whether it was asked for. Null for an
     * enrolment that carries none. The cap counts it ahead (0064 §3), and
     * the touches pull finds a send's message by it (§5). No key of the
     * person's: step numbers, delays and the messages' ids.
     */
    plan: jsonb("plan").$type<{ step: number; afterPreviousMinutes: number; messageId: string; unsolicited: boolean }[]>(),

    /**
     * For `suspended` (0051): the kernel's record of the stop, because the
     * provider's is not one — its status may keep reading active, and its
     * reference disappears with the object it points to. When the suspension
     * was asked, by which run, what the adapter read back from the provider
     * afterwards, and the way it stopped the person with the costs it
     * declared for it, as declared at that moment.
     */
    suspensionAskedAt: timestamp("suspension_asked_at", { withTimezone: true }),
    /** Attribution: losing the run keeps the suspension. */
    suspensionRunId: uuid("suspension_run_id").references(() => run.id, { onDelete: "set null" }),
    suspensionReadBack: jsonb("suspension_read_back"),
    suspensionMethod: text("suspension_method"),
    suspensionCosts: jsonb("suspension_costs"),
    /**
     * For a stop no provider read back (0056): what a person attested at a
     * terminal, and the case it answers — never in `suspension_read_back`,
     * which holds only what a provider returned. The run it was recorded under
     * says who. A suspended row holds this or a read-back, never both.
     */
    suspensionAttestation: jsonb("suspension_attestation"),

    /**
     * The way out after the body (decision 0067 §3), written once, when the
     * enrolment is made, and never rewritten — the migration's trigger
     * refuses it, but for erasure, which replaces the line and the link,
     * which name the person's record at the provider. Null on a row made
     * before 0067, or not yet made. See `wayOutState`: `written` is not
     * delivered.
     */
    wayOut: wayOutState("way_out"),
    /** For `written`: the line as written, its link in it. */
    wayOutLine: text("way_out_line"),
    /** For `written`: the provider's link, as the adapter returned it and the line carries it. */
    wayOutLink: text("way_out_link"),
    /** For `written`: when the provider's record read back the line. Not when the person received it. */
    wayOutReadBackAt: timestamp("way_out_read_back_at", { withTimezone: true }),
    /** For `cut` and `absent`: why, in words. */
    wayOutWhy: text("way_out_why"),

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

    /**
     * A suspended row carries its whole record, and any other row carries
     * none of it — not even a part. The record is a proof or an attestation,
     * exactly one (0056): what the provider read back, with the adapter's way
     * and costs, or what a person affirmed, with none of those. A verified
     * stop and an affirmed one are never the same row shape. Compared as
     * text: the value was added in a migration that also used it.
     * `suspension_run_id` is attribution, and may be null on either side.
     */
    check(
      "enrolment_suspension_recorded",
      sql`(${t.state}::text = 'suspended' and ${t.suspensionAskedAt} is not null and (
             (${t.suspensionReadBack} is not null and ${t.suspensionMethod} is not null and ${t.suspensionCosts} is not null and ${t.suspensionAttestation} is null)
          or (${t.suspensionAttestation} is not null and ${t.suspensionReadBack} is null and ${t.suspensionMethod} is null and ${t.suspensionCosts} is null)))
       or (${t.state}::text <> 'suspended' and ${t.suspensionAskedAt} is null and ${t.suspensionRunId} is null and ${t.suspensionReadBack} is null and ${t.suspensionMethod} is null and ${t.suspensionCosts} is null and ${t.suspensionAttestation} is null)`,
    ),
    /**
     * The way out's record, whole or absent, in both directions (0067): each
     * state carries the columns it needs and none of the others, and a row
     * with no state carries none of them. A form "state = X equals these
     * columns are set" is met when both sides are false, and would let a row
     * with no state carry part of a record. Only a made enrolment carries
     * one: `enrolled`, or `suspended` after it. Each branch says `is not
     * null` first: a comparison with a null state is null, not false, and a
     * check that comes out null passes — it let a row with no state carry a
     * reason alone until a test refused it.
     */
    check(
      "enrolment_way_out_recorded",
      sql`(${t.wayOut} is null and ${t.wayOutLine} is null and ${t.wayOutLink} is null and ${t.wayOutReadBackAt} is null and ${t.wayOutWhy} is null)
       or (${t.wayOut} is not null and ${t.wayOut} = 'written' and ${t.state}::text in ('enrolled', 'suspended') and ${t.wayOutLine} is not null and ${t.wayOutLink} is not null and ${t.wayOutReadBackAt} is not null and ${t.wayOutWhy} is null)
       or (${t.wayOut} is not null and ${t.wayOut} in ('cut', 'absent') and ${t.state}::text in ('enrolled', 'suspended') and ${t.wayOutLine} is null and ${t.wayOutLink} is null and ${t.wayOutReadBackAt} is null and ${t.wayOutWhy} is not null)`,
    ),
  ],
);

/**
 * Why a step before erasure could not stop an enrolment (decision 0056): one
 * row per enrolment per refused erasure run. What opens a person's
 * attestation for a provider that no longer answers — the one case the
 * kernel cannot tell from a timeout, so it must have been refused at least
 * once. It holds no answer from the provider, which may quote the person:
 * only the case.
 */
export const suspensionRefusal = acquisition.table(
  "suspension_refusal",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Restrict: an enrolment is history and is never deleted (0053). */
    enrolmentId: uuid("enrolment_id")
      .notNull()
      .references(() => enrolment.id, { onDelete: "restrict" }),
    /**
     * `unbound`: no sequencer takes the row's channel. `other_provider`: the
     * one that does is not the one the row was made through. `cannot_suspend`:
     * it declares that it cannot. `unanswered`: the call failed — retryable,
     * or a provider that will never answer again.
     */
    reason: text("reason").notNull(),
    /** Attribution: the erasure's run. */
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `refusedOn(enrolmentId)` — whether an attestation may open for it. */
    index("suspension_refusal_enrolment_idx").on(t.enrolmentId),
    check("suspension_refusal_reason", sql`${t.reason} in ('unbound', 'other_provider', 'cannot_suspend', 'unanswered')`),
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
export const enrolmentSkip = acquisition.table(
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
export const sourcingOutcome = acquisition.enum("sourcing_outcome", [
  "kept",
  "protected",
  // A domain that is not a host could match nothing: excluded, fail closed (0044).
  "unreadable_key",
  // An address completion gave at another company than the one targeted (0045).
  "off_target",
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
export const sourcingResult = acquisition.table(
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

/**
 * What a person has acknowledged protection cannot reach, each named:
 *
 * - **a customer, uncovered** (decision 0034): the protected set holds it,
 *   and none of its rows carries a key, so nothing protects it;
 * - **an account, unmatched** (decision 0068): the protected set knows it by
 *   the source's own identifier alone, which no company on record carries,
 *   so an enrolment can match nothing against it.
 *
 * A run that finds either stops unless it is acknowledged here, by its name;
 * one that finds acknowledged ones goes on and says so. Nothing here
 * acknowledges what it does not name: a new one stops the run again.
 *
 * Written only by `kernel-acknowledge`, by a person, each acknowledgement
 * and each withdrawal in its own recorded run. A run reads it and never
 * writes it. Withdrawn rows stay: who acknowledged what, and when it ended,
 * is the record.
 */
export const protectionAcknowledgement = acquisition.table(
  "protection_acknowledgement",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** The customer as the protected set names it, for an uncovered one. Never matched against a candidate. */
    customerId: text("customer_id"),
    /** The account's identifier in the source, for an unmatched one (0068). Never matched against anything. */
    accountId: text("account_id"),
    /** Why it may stay uncovered or unmatched, in the person's words. */
    note: text("note").notNull(),

    /** Doctrine 5. A person, always: the check below refuses anything else. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    /** Restrict: the run that acknowledged is the evidence, and is not quietly deleted. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),

    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnBy: text("withdrawn_by"),
    withdrawnRunId: uuid("withdrawn_run_id").references(() => run.id, { onDelete: "restrict" }),
  },
  (t) => [
    /**
     * One standing acknowledgement per customer. It protects the write path
     * of `kernel-acknowledge`: acknowledging a customer twice keeps one.
     * Also serves `readAcknowledged()` — the standing set, read by every run
     * before protection.
     */
    uniqueIndex("protection_acknowledgement_standing_uidx").on(t.customerId).where(sql`${t.withdrawnAt} is null`),
    /** The same, per account (0068): acknowledging an account twice keeps one; serves `readAcknowledgedAccounts()`. */
    uniqueIndex("protection_acknowledgement_account_standing_uidx").on(t.accountId).where(sql`${t.withdrawnAt} is null`),
    /** One name per acknowledgement: a customer or an account, never both, never neither. */
    check("protection_acknowledgement_names_one_check", sql`(${t.customerId} is null) <> (${t.accountId} is null)`),

    check("protection_acknowledgement_human_check", sql`${t.actorType} = 'human'`),
    check(
      "protection_acknowledgement_withdrawal_check",
      sql`(${t.withdrawnAt} is null) = (${t.withdrawnBy} is null) and (${t.withdrawnAt} is null) = (${t.withdrawnRunId} is null)`,
    ),
  ],
);

/**
 * Where each inbound source was last read up to (decision 0039): one row per
 * source, as its adapter names itself. The bookkeeping of reading through
 * this domain's `Inbound` contract, so it is here and not in the core, which
 * records work, not how a domain reads its sources.
 *
 * It is also how a source has one writer: `pullInbound` holds the row locked
 * for the whole read, so two pulls of one source wait for each other. The
 * cursor advances in the transaction that stores the page it covers — a
 * crash replays a page, stored once by `core.event`'s key, and never skips
 * one.
 */
export const inboundCursor = acquisition.table("inbound_cursor", {
  /** The source, as its adapter names itself — the `provider` of its events. */
  provider: text("provider").primaryKey(),
  /** Opaque: the adapter's. Absent until a first page is stored. */
  cursor: text("cursor"),
  /** The run that last advanced it. Attribution: losing the run keeps the cursor. */
  runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How far 0004's promise is known to hold (decision 0057): one row per run of
 * the act that stopped every enrolment it found at a protected account, with
 * the protected set it read. A run that found nobody to stop writes one too:
 * it is the most telling — it says the promise held as of that set — and
 * nothing else would keep it, not the suspensions, of which it made none.
 *
 * Written only once the act succeeded, and never by a dry run: a run whose
 * act failed held nothing, and its run row says why. The promise holds only
 * as often as a run writes here; between two rows, an account that became
 * protected keeps receiving every step its sequences send.
 *
 * Its age is not stored. It is read against the run's own time
 * (`core.run.started_at`), and a column derived from two others drifts.
 */
export const protectionHeld = acquisition.table(
  "protection_held",
  {
    /**
     * The run of the act: an enrolment run, whose start runs it, or the
     * command's own. One row per run, which the primary key protects: the act
     * runs once in a run. Cascade: the row is that run's.
     */
    runId: uuid("run_id")
      .primaryKey()
      .references(() => run.id, { onDelete: "cascade" }),
    /** When the protected set was computed, as its source said (0041) — never the time it was read. */
    protectedAsOf: timestamp("protected_as_of", { withTimezone: true }).notNull(),
    /** How many distinct protected accounts that set held (0033). */
    accounts: integer("accounts").notNull(),
  },
  (t) => [
    /** "How far the promise is known to hold": the latest protected set a run held it against. */
    index("protection_held_as_of_idx").on(t.protectedAsOf),
  ],
);
