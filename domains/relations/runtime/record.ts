/**
 * relations/runtime — the only writes into this domain's tables, for every
 * domain that needs one (doctrine 2: a domain never writes into another's
 * entities; it calls the owner).
 *
 * A person or a company is recorded from an identity (decision 0013) by the
 * keys this schema has columns for, and nothing is merged:
 *
 * - **A person** is found by its immutable key first — a profile id on a
 *   network, kept in `external_id` as `<network>:<id>` — then by address,
 *   compared without case.
 * - **A company** is found by its id on a network the same way, then by
 *   domain, compared without case.
 *
 * Two rows that each match one key, or a row whose immutable key differs from
 * the identity's, are two subjects by 0013's rule, and the answer is
 * `conflict`, never a merge and never a guess at which one was meant.
 * Recording fills a column that is empty; it never overwrites one that is
 * not.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Identity } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";
import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";

import { company, person, touch } from "../db/schema.js";

export type Found = { id: string } | { none: true } | { conflict: string };

const first = (identity: Identity, kind: string) => identity.keys.find((k) => k.kind === kind && k.value.trim() !== "");
const networked = (identity: Identity, kind: string) => {
  const key = identity.keys.find((k) => k.kind === kind && k.value.trim() !== "" && k.network);
  return key ? `${key.network}:${key.value.trim()}` : undefined;
};

/** A domain as it is recorded and found: its host (decision 0028), or nothing when none is left. */
const hostOfKey = (value: string | undefined) => (value === undefined ? undefined : hostOf(value) || undefined);

/** The keys a person is recorded by, or why it cannot be. */
function personKeys(identity: Identity): { email?: string; externalId?: string } | { refused: string } {
  if (identity.subject !== "person") return { refused: `a ${identity.subject} is not a person` };
  const email = first(identity, "email")?.value.trim().toLowerCase();
  const externalId = networked(identity, "social_profile_id");
  if (!email && !externalId) return { refused: "the identity has neither an address nor a profile id to record a person by" };
  return { ...(email ? { email } : {}), ...(externalId ? { externalId } : {}) };
}

function companyKeys(identity: Identity): { domain?: string; externalId?: string } | { refused: string } {
  if (identity.subject !== "company") return { refused: `a ${identity.subject} is not a company` };
  const domain = hostOfKey(first(identity, "domain")?.value);
  const externalId = networked(identity, "social_company_id");
  if (!domain && !externalId) return { refused: "the identity has neither a domain nor a company id to record a company by" };
  return { ...(domain ? { domain } : {}), ...(externalId ? { externalId } : {}) };
}

/** One row from either key, or the reason the two keys name two subjects. */
function settle(
  byImmutable: { id: string; externalId: string | null } | undefined,
  byMutable: { id: string; externalId: string | null } | undefined,
  externalId: string | undefined,
  what: string,
): Found {
  if (byImmutable && byMutable && byImmutable.id !== byMutable.id) {
    return { conflict: `the ${what}'s id and its other key name two recorded ${what === "person" ? "people" : "companies"}` };
  }
  const row = byImmutable ?? byMutable;
  if (!row) return { none: true };
  if (externalId && row.externalId && row.externalId !== externalId) {
    return { conflict: `a recorded ${what} shares a key with this one and has another immutable id` };
  }
  return { id: row.id };
}

/** Reads only: the recorded person for an identity, if there is one. */
export async function findPerson(db: Database, identity: Identity): Promise<Found> {
  const keys = personKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const cols = { id: person.id, externalId: person.externalId };
  const [byImmutable] = keys.externalId ? await db.select(cols).from(person).where(eq(person.externalId, keys.externalId)) : [];
  const [byMutable] = keys.email ? await db.select(cols).from(person).where(sql`lower(${person.email}) = ${keys.email}`) : [];
  return settle(byImmutable, byMutable, keys.externalId, "person");
}

export async function findCompany(db: Database, identity: Identity): Promise<Found> {
  const keys = companyKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const cols = { id: company.id, externalId: company.externalId };
  const [byImmutable] = keys.externalId ? await db.select(cols).from(company).where(eq(company.externalId, keys.externalId)) : [];
  const [byMutable] = keys.domain ? await db.select(cols).from(company).where(sql`lower(${company.domain}) = ${keys.domain}`) : [];
  return settle(byImmutable, byMutable, keys.externalId, "company");
}

/**
 * The company's row, made if there is none. `name` is required by the table;
 * without one the domain stands in, which is a label, not an invented fact.
 */
export async function recordCompany(db: Database, identity: Identity, display: { name?: string } = {}): Promise<{ id: string } | { conflict: string }> {
  const keys = companyKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const found = await findCompany(db, identity);
  if ("conflict" in found) return found;
  if ("id" in found) {
    // Fill what is empty, one column at a time, and only where it is empty.
    if (keys.externalId) await db.update(company).set({ externalId: keys.externalId, updatedAt: new Date() }).where(and(eq(company.id, found.id), isNull(company.externalId)));
    if (keys.domain) await db.update(company).set({ domain: keys.domain, updatedAt: new Date() }).where(and(eq(company.id, found.id), isNull(company.domain)));
    return found;
  }
  await db
    .insert(company)
    .values({ name: display.name ?? keys.domain ?? keys.externalId!, ...(keys.domain ? { domain: keys.domain } : {}), ...(keys.externalId ? { externalId: keys.externalId } : {}) })
    .onConflictDoNothing();
  // Read back, whoever won a race to insert it.
  const settled = await findCompany(db, identity);
  if ("none" in settled) throw new Error("a company was inserted and cannot be read back");
  return settled;
}

export async function recordPerson(
  db: Database,
  identity: Identity,
  display: { fullName?: string; companyId?: string } = {},
): Promise<{ id: string } | { conflict: string }> {
  const keys = personKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const found = await findPerson(db, identity);
  if ("conflict" in found) return found;
  if ("id" in found) {
    if (keys.externalId) await db.update(person).set({ externalId: keys.externalId, updatedAt: new Date() }).where(and(eq(person.id, found.id), isNull(person.externalId)));
    if (keys.email) await db.update(person).set({ email: keys.email, updatedAt: new Date() }).where(and(eq(person.id, found.id), isNull(person.email)));
    if (display.companyId) await db.update(person).set({ companyId: display.companyId, updatedAt: new Date() }).where(and(eq(person.id, found.id), isNull(person.companyId)));
    return found;
  }
  await db
    .insert(person)
    .values({
      ...(keys.email ? { email: keys.email } : {}),
      ...(keys.externalId ? { externalId: keys.externalId } : {}),
      ...(display.fullName ? { fullName: display.fullName } : {}),
      ...(display.companyId ? { companyId: display.companyId } : {}),
    })
    .onConflictDoNothing();
  const settled = await findPerson(db, identity);
  if ("none" in settled) throw new Error("a person was inserted and cannot be read back");
  return settled;
}

/**
 * Outbound says whether the person asked for it, with no default (decision
 * 0036): a support answer is solicited, a sales follow-up is not, and only
 * the unsolicited count against a cap. Inbound is the person's own act.
 */
export type TouchDirection = { direction: "outbound"; unsolicited: boolean } | { direction: "inbound" };

export type TouchInput = TouchDirection & {
  personId: string;
  channel: string;
  provider: string;
  providerEventId: string;
  occurredAt: Date;
  sender?: string;
  outcome?: string;
  experimentId?: string;
  actor: { type: ActorKind; id?: string };
  runId?: string;
};

/**
 * Appends one touch. A provider event already recorded is not a second touch:
 * the unique key on (provider, provider_event_id) is in the DDL (doctrine 4),
 * and a replay returns `recorded: false` rather than an error.
 */
export async function recordTouch(db: Database, input: TouchInput): Promise<{ recorded: boolean }> {
  const inserted = await db
    .insert(touch)
    .values({
      personId: input.personId,
      channel: input.channel,
      direction: input.direction,
      unsolicited: input.direction === "outbound" ? input.unsolicited : false,
      provider: input.provider,
      providerEventId: input.providerEventId,
      occurredAt: input.occurredAt,
      ...(input.sender ? { sender: input.sender } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      actorType: input.actor.type,
      ...(input.actor.id ? { actorId: input.actor.id } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    })
    .onConflictDoNothing({ target: [touch.provider, touch.providerEventId] })
    .returning({ id: touch.id });
  return { recorded: inserted.length === 1 };
}

/**
 * Records that a person asked to stop, from the moment they did (decision
 * 0039: an unsubscribe read from a source is applied, not only stored). An
 * opt-out already recorded is kept as it is — the first moment stands — and
 * nothing here ever clears one.
 */
export async function recordOptOut(db: Database, personId: string, at: Date): Promise<{ recorded: boolean }> {
  const changed = await db
    .update(person)
    .set({ optedOutAt: at, updatedAt: new Date() })
    .where(and(eq(person.id, personId), isNull(person.optedOutAt)))
    .returning({ id: person.id });
  return { recorded: changed.length === 1 };
}
