/**
 * relations — the shared record: people, companies, the lists they were selected on,
 * and the interactions and signals that concern them.
 *
 * Every other domain references these and adds its own tables; none of them
 * writes here (doctrine 2). `touch` and `signal` live at this layer rather
 * than in an acquisition domain because an interaction with a person is not
 * one domain's concern: outreach writes them, marketing will, sales will.
 * When two domains need a concept, it moves down.
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

export const relations = pgSchema("relations");

export const direction = relations.enum("direction", ["outbound", "inbound"]);

export const emailStatus = relations.enum("email_status", [
  "unknown",
  "valid",
  "risky",
  "catch_all",
  "invalid",
]);

/**
 * A relationship with a subject, true whether or not anyone is prospecting
 * (decision 0036). `none` is how a mistaken declaration is corrected: by
 * another, never by an edit.
 */
export const relationshipStatus = relations.enum("relationship_status", ["customer", "former_customer", "none"]);

/**
 * A company.
 *
 * A reference plus what we compute. Firmographics, revenue and relationship
 * status are facts other systems own: read on demand, never copied
 * (doctrine 3). The research cache is the one exception, and exists only to
 * stop paying twice for the same id inside its TTL.
 */
export const company = relations.table(
  "company",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Canonical key. Slugs and URLs drift; a numeric id does not. */
    externalId: text("external_id"),
    domain: text("domain"),
    name: text("name").notNull(),

    /** Opaque id in whatever system of record this instance is configured against. */
    recordId: text("record_id"),

    researchData: jsonb("research_data"),
    researchFetchedAt: timestamp("research_fetched_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Idempotency key for every sourcing path. Partial: a company can arrive domain-first. */
    uniqueIndex("company_external_id_uidx")
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),

    /** Fallback key, and the join an inbound signup lands on. */
    uniqueIndex("company_domain_lower_uidx")
      .on(sql`lower(${t.domain})`)
      .where(sql`${t.domain} is not null`),

    /** `listCompaniesNeedingResearch`: research_fetched_at null or stale. */
    index("company_research_fetched_at_idx").on(t.researchFetchedAt),
  ],
);

/**
 * A person.
 *
 * `companyId` is nullable and that is load-bearing: a signup is an address
 * before it is anything else, and forcing a company row at that moment
 * invents data.
 */
export const person = relations.table(
  "person",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    externalId: text("external_id"),
    email: text("email"),
    fullName: text("full_name"),
    title: text("title"),

    companyId: uuid("company_id").references(() => company.id, {
      // Attribution, not ownership: losing the company must not lose the person.
      onDelete: "set null",
    }),

    recordId: text("record_id"),
    emailStatus: emailStatus("email_status").notNull().default("unknown"),

    /**
     * Global opt-out, read by the exclusion pass, which fails closed. No
     * experiment overrides it, whatever its lane.
     */
    optedOutAt: timestamp("opted_out_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("person_external_id_uidx")
      .on(t.externalId)
      .where(sql`${t.externalId} is not null`),

    /**
     * Case-insensitive, because this is the join that answers which work
     * reached a person before they arrived on their own. Known weak on its
     * own, which is why the external id stays the key of record and the
     * address is an attribute. If a first backfill proves it insufficient,
     * the answer is an identity table — decided by that backfill, not here.
     */
    uniqueIndex("person_email_lower_uidx")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),

    index("person_company_id_idx").on(t.companyId),
  ],
);

/**
 * A list: people or companies selected together, frozen at the moment the
 * list is constituted (decision 0037). The evidence of what was targeted, so
 * it does not move: members are written in the transaction that makes the
 * list, which is then sealed, and a trigger refuses any member added or
 * changed after. The query that produced it is kept beside it, as the
 * selecting process gave it, so the selection can be replayed into a new
 * list and the two compared.
 *
 * **A selection, never a permission.** Consent, opt-out and protection are
 * read when something is sent, not when a list is made: a list frozen in
 * January holds someone who opts out in February. Nothing reads membership as
 * leave to contact. Exclusion is not a list either — it is read live, where
 * it is fresh (doctrine 6).
 *
 * Not `audience`: that word is kept for an anonymous segment.
 */
export const list = relations.table(
  "list",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Stable name a process or an experiment's targets refer to. */
    key: text("key").notNull(),
    description: text("description"),

    /** The selection as the selecting process declared it. Opaque here; kept to replay it. */
    query: jsonb("query").notNull(),

    /** Null while members are written, set once in the same transaction; then nothing moves. */
    sealedAt: timestamp("sealed_at", { withTimezone: true }),

    /** Doctrine 5. Any actor may select; the run is the evidence, so it is restricted. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `constituteList` replayed with the same key keeps the first list. */
    uniqueIndex("list_key_uidx").on(t.key),
  ],
);

export const listMember = relations.table(
  "list_member",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    listId: uuid("list_id")
      .notNull()
      .references(() => list.id, { onDelete: "cascade" }),

    /**
     * Exactly one is set — the check below. Cascade: erasing a person must
     * never be blocked by a list they were once on; that deletion is the one
     * change a sealed list lets through.
     */
    companyId: uuid("company_id").references(() => company.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => person.id, { onDelete: "cascade" }),

    /** Why this one was selected, when the selecting process says. */
    reason: text("reason"),
  },
  (t) => [
    check("list_member_one_subject", sql`num_nonnulls(${t.companyId}, ${t.personId}) = 1`),

    /** A subject is on a list once: `constituteList` given a duplicate keeps one. */
    uniqueIndex("list_member_company_uidx")
      .on(t.listId, t.companyId)
      .where(sql`${t.companyId} is not null`),
    uniqueIndex("list_member_person_uidx")
      .on(t.listId, t.personId)
      .where(sql`${t.personId} is not null`),

    /** `listsOf(personId)` — which lists a person was selected on, for erasure and for a debrief. */
    index("list_member_person_idx").on(t.personId),
    index("list_member_company_idx").on(t.companyId),
  ],
);

/**
 * Append-only record of a real interaction with a person, in either direction.
 *
 * This is the table the whole design exists for: has this person already been
 * reached, by which experiment, on which channel, and when.
 *
 * It is not a mirror of the provider (doctrine 3). A touch is written when
 * something changes a decision — an action that locks a re-contact rule, a
 * reply, a bounce. Volume the provider keeps is read from the provider.
 *
 * Append-only in the schema, not by convention (decision 0026): a trigger
 * refuses every UPDATE, so a touch is never rewritten into something that did
 * not happen. DELETE is left to the restrict on `person` and to an erasure
 * path, when there is one: a rule that forbade deleting a person's history
 * would forbid erasing the person.
 *
 * Written only through `recordTouch` in `runtime/record.ts`, which belongs to
 * this domain: another domain records a touch by calling it, never by writing
 * the table (doctrine 2).
 */
export const touch = relations.table(
  "touch",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Restrict: evidence of what was sent is not silently erased. */
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),

    /** Attribution: the experiment may be archived, the touch remains. */
    experimentId: uuid("experiment_id").references(() => experiment.id, {
      onDelete: "set null",
    }),

    /**
     * Contributed by domains, so text rather than an enum: an acquisition
     * domain and a marketing domain do not share a closed channel list, and
     * neither should have to migrate a type the other owns.
     */
    channel: text("channel").notNull(),
    direction: direction("direction").notNull(),

    /**
     * Which identity this went out from — a mailbox, an account, a page.
     * Capacity consumed is then a query over this column rather than a
     * counter that drifts, and deliverability becomes a group by.
     */
    sender: text("sender"),

    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),

    /**
     * Whether the person did not ask for it (decision 0036). `direction`
     * cannot say it: an answer to a support question and a sales follow-up
     * are both outbound. The solicitation cap reads unsolicited touches only,
     * so a reply is never held back by a cadence. Inbound is never
     * unsolicited — the check below.
     */
    unsolicited: boolean("unsolicited").notNull(),

    outcome: text("outcome"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    /** Doctrine 5: which run recorded it, on whose behalf. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** Idempotency key for every provider callback: a retry is not a second touch. */
    uniqueIndex("touch_provider_event_uidx").on(t.provider, t.providerEventId),

    /** `hasBeenReached(personId)` — the exclusion pass, on every run. */
    index("touch_person_occurred_at_idx").on(t.personId, sql`${t.occurredAt} desc`),

    /** `capacityUsed(sender, day)` — the pre-flight check before booking work. */
    index("touch_sender_occurred_at_idx").on(t.sender, sql`${t.occurredAt} desc`),

    /** What the person did is never outreach they did not ask for. */
    check("touch_inbound_not_unsolicited", sql`${t.direction} = 'outbound' or not ${t.unsolicited}`),
  ],
);

/**
 * An intent record about a person or a company. Deduplicated on a content
 * hash, because the same item reaches us from more than one source and
 * counting it twice inflates everything downstream.
 */
export const signal = relations.table(
  "signal",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    companyId: uuid("company_id").references(() => company.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => person.id, { onDelete: "cascade" }),

    /** Free text, not an enum: signal kinds are a domain concern that moves. */
    kind: text("kind").notNull(),
    source: text("source").notNull(),

    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** An expired signal with no touch is a miss, and is counted as one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("signal_one_target", sql`num_nonnulls(${t.companyId}, ${t.personId}) >= 1`),
    uniqueIndex("signal_content_hash_uidx").on(t.contentHash),

    /** `listExpiredSignalsWithoutTouch` on the weekly review. */
    index("signal_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * A relationship with a person or a company, declared by a person (decision
 * 0036): customer, former customer, or none. One row per declaration,
 * appended and never updated — a trigger refuses it — so what the record
 * said on any date can be read back. The current relationship is the latest
 * by `at`, read through `relationship_current`.
 *
 * Here and not in a domain that prospects, because it is true whether or not
 * anyone prospects (0035), and support, finance and product read it too.
 * One day the domain that observes the payment should write `customer`; until
 * it exists, a person declares it.
 *
 * `company` says relationship status is a fact other systems own, read and
 * never copied (doctrine 3). What this table holds is a person's declaration,
 * which this system owns; where a CRM holds the status too, there are two,
 * and which one a reader trusts is not settled (0036, "Tension left open").
 * The protected set is unchanged: protection reads its own source.
 */
export const relationship = relations.table(
  "relationship",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Exactly one is set — the check below. Cascade: the declaration is about its subject. */
    companyId: uuid("company_id").references(() => company.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => person.id, { onDelete: "cascade" }),

    status: relationshipStatus("status").notNull(),
    /** When it became true, as the person says. Not when it was written: that is `createdAt`. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** Why, in the person's words. A correction says what it corrects. */
    reason: text("reason"),

    /** Doctrine 5. A person, always: the check below refuses anything else. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    /** Restrict: the run that declared it is the evidence, and is not quietly deleted. */
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("relationship_one_subject", sql`num_nonnulls(${t.companyId}, ${t.personId}) = 1`),
    check("relationship_human_check", sql`${t.actorType} = 'human'`),

    /** `declareRelationship` replayed — same subject, status and moment — keeps one row. */
    uniqueIndex("relationship_company_uidx")
      .on(t.companyId, t.status, t.at)
      .where(sql`${t.companyId} is not null`),
    uniqueIndex("relationship_person_uidx")
      .on(t.personId, t.status, t.at)
      .where(sql`${t.personId} is not null`),

    /** `relationship_current` — the latest declaration per subject. */
    index("relationship_company_at_idx").on(t.companyId, sql`${t.at} desc`),
    index("relationship_person_at_idx").on(t.personId, sql`${t.at} desc`),
  ],
);

/**
 * The view `relations` publishes of each subject's current relationship:
 * its latest declaration by `at`, the latest written breaking a tie. A
 * subject with no declaration has no row — not a `none`.
 */
export const relationshipCurrent = relations
  .view("relationship_current", {
    companyId: uuid("company_id"),
    personId: uuid("person_id"),
    status: relationshipStatus("status").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
  })
  .as(
    sql`select distinct on (coalesce(company_id, person_id)) company_id, person_id, status, at, reason, actor_id from relations.relationship order by coalesce(company_id, person_id), at desc, created_at desc`,
  );
