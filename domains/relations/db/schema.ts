/**
 * relations — the shared record: people, companies, the sets they belong to,
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

/** Include sets feed sourcing; exclude sets fail closed. */
export const audienceKind = relations.enum("audience_kind", ["include", "exclude"]);

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
 * A named set of people or companies, with the rule that put each member
 * there and the date it did.
 *
 * One mechanism instead of four tables: target lists, suppression,
 * do-not-contact, and sets published by a sibling system. Membership is
 * derived and re-evaluated, never written once and trusted forever.
 */
export const audience = relations.table(
  "audience",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Stable name used by manifest rules, e.g. `exclude:protected-accounts`. */
    key: text("key").notNull(),

    kind: audienceKind("kind").notNull(),
    description: text("description"),

    /** Declarative filter, as declared in the instance manifest. */
    definition: jsonb("definition"),

    /**
     * Freshness, not reachability, is what the exclusion pass fails closed on
     * (doctrine 6). A source answering cheerfully with last week's rows is
     * worse than one that is down, because it looks like protection.
     */
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    maxStalenessMinutes: integer("max_staleness_minutes").notNull().default(1440),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("audience_key_uidx").on(t.key)],
);

export const audienceMember = relations.table(
  "audience_member",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    audienceId: uuid("audience_id")
      .notNull()
      .references(() => audience.id, { onDelete: "cascade" }),

    /** Exactly one of these is set — see the check below. */
    companyId: uuid("company_id").references(() => company.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => person.id, { onDelete: "cascade" }),

    source: text("source").notNull(),
    /** Which rule produced it, so a wrong exclusion traces back to its rule. */
    rule: text("rule"),
    reason: text("reason"),

    asOf: timestamp("as_of", { withTimezone: true }).notNull().defaultNow(),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
  },
  (t) => [
    /** Polymorphic membership without giving up referential integrity. */
    check("audience_member_one_target", sql`num_nonnulls(${t.companyId}, ${t.personId}) = 1`),

    /** Replay safety: re-running an ingestion must not duplicate a member. */
    uniqueIndex("audience_member_company_uidx")
      .on(t.audienceId, t.companyId)
      .where(sql`${t.companyId} is not null`),
    uniqueIndex("audience_member_person_uidx")
      .on(t.audienceId, t.personId)
      .where(sql`${t.personId} is not null`),

    /** The exclusion pass: `isExcluded(personId)` / `isExcluded(companyId)`. */
    index("audience_member_company_lookup_idx").on(t.companyId, t.audienceId),
    index("audience_member_person_lookup_idx").on(t.personId, t.audienceId),
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
 * What is sent to a person (decision 0038): this content, on this channel,
 * from this sender, handed over to be sent at this moment. True whichever
 * domain sends it — a support answer, an announcement, a follow-up — so it is
 * here, below all of them (0035), and not in the domain that prospects.
 *
 * Appended, never updated: what happened to it afterwards — delivered,
 * bounced, replied — is a touch.
 *
 * Writing one is a gate, beside the draft's (0027): `writeMessage` in
 * `runtime/message.ts` refuses a send that is not lawful — an opted-out
 * person, an unsolicited message past the caller's cap, a message no person
 * and no lane approved. The schema holds the lane's half: a message whose
 * actor is not a person carries an approval, or is refused.
 */
export const message = relations.table(
  "message",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** The writer's key for this send, e.g. the draft it comes from. A replayed write is one message. */
    key: text("key").notNull(),

    /** Restrict: evidence of what was sent is not silently erased, as for a touch. */
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),

    /** Attribution: the experiment may be archived, the message remains. */
    experimentId: uuid("experiment_id").references(() => experiment.id, { onDelete: "set null" }),

    channel: text("channel").notNull(),
    sender: text("sender"),
    subject: text("subject"),
    body: text("body").notNull(),

    /** Whether the person did not ask for it. Only these count against the cap. */
    unsolicited: boolean("unsolicited").notNull(),

    /**
     * Who approved sending it, when its writer is not a person: a person's
     * name, or `lane:autonomous`. Null only for a message a person wrote —
     * the check below.
     */
    approvedBy: text("approved_by"),

    /** Doctrine 5. */
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id"),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),

    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** `writeMessage` replayed with the same key keeps one message. */
    uniqueIndex("message_key_uidx").on(t.key),

    /** The cadence check: unsolicited messages to a person inside the cap's window. */
    index("message_person_unsolicited_idx")
      .on(t.personId, sql`${t.writtenAt} desc`)
      .where(sql`${t.unsolicited}`),

    check("message_approved_check", sql`${t.actorType} = 'human' or ${t.approvedBy} is not null`),
  ],
);
