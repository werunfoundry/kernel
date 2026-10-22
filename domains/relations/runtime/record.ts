/**
 * relations/runtime — the only writes into this domain's tables, for every
 * domain that needs one (doctrine 2: a domain never writes into another's
 * entities; it calls the owner).
 *
 * A person or a company is recorded from an identity (decision 0013) by the
 * keys this schema has columns for, and nothing is merged:
 *
 * - **A person** is found by every key of the identity (decision 0013: an
 *   identity is a set of keys) — each profile id on a network, kept in
 *   `external_id` as `<network>:<id>`, and each address, compared without
 *   case. Not the first of each: a person who opted out under the second
 *   address the source attests is that person.
 * - **A company** is found by its id on a network the same way, then by
 *   domain, compared without case.
 *
 * Two rows that each match one key, or a row whose immutable key differs from
 * the identity's, are two subjects by 0013's rule, and the answer is
 * `conflict`, never a merge and never a guess at which one was meant.
 * Recording fills a column that is empty; it never overwrites one that is
 * not.
 */

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import type { Identity, IdentityKey } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";
import type { Fingerprinter } from "@werunfoundry/core/runtime/fingerprint";
import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";

import { company, person, suppression, touch } from "../db/schema.js";

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

/**
 * Reads only: the recorded person for an identity, if there is one — found
 * by any of its keys, every one of them looked up. Two recorded people
 * reached by the keys of one identity are two subjects (0013), and the
 * answer is `conflict`; so is a recorded person whose profile id on a
 * network differs from the identity's on that network.
 */
export async function findPerson(db: Database, identity: Identity): Promise<Found> {
  const keys = personKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const emails = [...new Set(identity.keys.filter((k) => k.kind === "email" && k.value.trim() !== "").map((k) => k.value.trim().toLowerCase()))];
  const ids = [
    ...new Set(identity.keys.filter((k) => k.kind === "social_profile_id" && k.network && k.value.trim() !== "").map((k) => `${k.network}:${k.value.trim()}`)),
  ];
  const reached = [
    ...(ids.length ? [sql`${person.externalId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`] : []),
    ...(emails.length ? [sql`lower(${person.email}) in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`] : []),
  ];
  const rows = await db.select({ id: person.id, externalId: person.externalId }).from(person).where(sql.join(reached, sql` or `));
  if (rows.length === 0) return { none: true };
  if (rows.length > 1) return { conflict: "the person's keys name two recorded people" };
  const row = rows[0]!;
  // An immutable key of the same network that differs: another subject, whatever else is shared (0013).
  const network = row.externalId?.split(":")[0];
  if (row.externalId && ids.some((i) => i.split(":")[0] === network) && !ids.includes(row.externalId)) {
    return { conflict: "a recorded person shares a key with this one and has another immutable id" };
  }
  return { id: row.id };
}

export async function findCompany(db: Database, identity: Identity): Promise<Found> {
  const keys = companyKeys(identity);
  if ("refused" in keys) return { conflict: keys.refused };
  const cols = { id: company.id, externalId: company.externalId };
  const [byImmutable] = keys.externalId ? await db.select(cols).from(company).where(eq(company.externalId, keys.externalId)) : [];
  const [byMutable] = keys.domain ? await db.select(cols).from(company).where(sql`lower(${company.domain}) = ${keys.domain}`) : [];
  return settle(byImmutable, byMutable, keys.externalId, "company");
}

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A recorded subject, from what a person types at a terminal (decision 0047):
 * its row id, or its key — an address for a person, a domain for a company.
 * Reads only. A key that names nothing is refused: a command never creates
 * what it declares about.
 */
export type Named = { id: string; label: string } | { refused: string };

export async function namePerson(db: Database, typed: string): Promise<Named> {
  const key = typed.trim();
  if (uuidShape.test(key)) {
    const [row] = await db.select({ id: person.id, email: person.email }).from(person).where(eq(person.id, key));
    return row ? { id: row.id, label: row.email ?? row.id } : { refused: `no person ${key} is on record` };
  }
  if (!key.includes("@")) return { refused: `"${key}" is neither an address nor a person's id` };
  const found = await findPerson(db, { subject: "person", keys: [{ kind: "email", value: key }] });
  if ("conflict" in found) return { refused: found.conflict };
  return "none" in found ? { refused: `no person with the address ${key} is on record` } : { id: found.id, label: key.toLowerCase() };
}

export async function nameCompany(db: Database, typed: string): Promise<Named> {
  const key = typed.trim();
  if (uuidShape.test(key)) {
    const [row] = await db.select({ id: company.id, domain: company.domain, name: company.name }).from(company).where(eq(company.id, key));
    return row ? { id: row.id, label: row.domain ?? row.name } : { refused: `no company ${key} is on record` };
  }
  // An empty host is refused by findCompany: it has no key to find a company by.
  const domain = hostOf(key);
  const found = await findCompany(db, { subject: "company", keys: [{ kind: "domain", value: domain }] });
  if ("conflict" in found) return { refused: found.conflict };
  return "none" in found ? { refused: `no company with the domain ${domain} is on record` } : { id: found.id, label: domain };
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
  /**
   * The message this touch delivered: the step's, by the plan of the
   * enrolment that carried it (decision 0064), read by the touches pull.
   */
  messageId?: string;
  actor: { type: ActorKind; id?: string };
  runId?: string;
};

/**
 * Appends one touch. A provider event already recorded is not a second touch,
 * and neither is a second confirmation of one message's hand-over: both keys
 * are unique in the DDL (doctrine 4), and a replay returns `recorded: false`
 * rather than an error.
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
      ...(input.messageId ? { messageId: input.messageId } : {}),
      actorType: input.actor.type,
      ...(input.actor.id ? { actorId: input.actor.id } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    })
    // Untargeted: either key held is a replay — the provider's event, or the message's hand-over.
    .onConflictDoNothing()
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

/**
 * What erasing a person does to their opt-out (decisions 0049, 0052), said
 * wherever an erasure is shown. The objection survives as fingerprints in
 * the register, which the one reader reads (0055, below), by the keys in
 * hand: a key the erasure did not gather does not find it. Silence about
 * that would read as protection.
 */
export const OPT_OUT_AFTER_ERASURE =
  "the opt-out survives only as fingerprints in the register (decision 0052), one per key the erasure gathered: the one reader (decision 0055) finds the person objecting by any of those keys, and by no other. Live enrolment stays refused once an erasure has run, until the passage holds the threshold. A person who did not object leaves nothing"

/**
 * The one reader of an objection (decision 0055, §3). Whether a person
 * objected, from the keys in hand or a recorded person's id: their opt-out
 * on record, then the register (0052) for every key, under every chain an
 * entry is keyed under. Every read of the objection goes through it.
 *
 * - **objected**: an opt-out on record, or a key in the register;
 * - **none**: no objection on record. Keys that name nobody recorded and
 *   match no entry are not "objected": the kernel honours the objections it
 *   observed, and an erased objector found again is found by the register;
 * - **cannot answer**:
 *   - an id that names no row, or keys that name two people: there is
 *     nobody to answer for, and it is never recorded as an objection.
 *     `stops` is false: the caller refuses this one person;
 *   - a version whose secret is not held, declared missing (0063) or named
 *     by an entry's chain: an entry under it cannot be recognised. `stops`
 *     is true: the run stops (0052).
 *
 * A record or register that cannot be read throws, and the run stops with
 * it. `lock` locks the person's row, for a writer that counts against it.
 */
export type Objection =
  | { answer: "objected"; by: "record" | "register"; personId?: string }
  | { answer: "none"; personId?: string }
  | { answer: "cannot_answer"; why: string; stops: boolean };

export async function readObjection(
  db: Database,
  fingerprints: Fingerprinter,
  asked: { personId: string } | { identity: Identity },
  options: { lock?: boolean } = {},
): Promise<Objection> {
  let personId: string | undefined;
  const keys: IdentityKey[] = [];
  if ("identity" in asked) {
    const found = await findPerson(db, asked.identity);
    if ("conflict" in found) return { answer: "cannot_answer", why: found.conflict, stops: false };
    if ("id" in found) personId = found.id;
    keys.push(...asked.identity.keys);
  } else {
    personId = asked.personId;
  }
  if (personId !== undefined) {
    const read = db.select({ optedOutAt: person.optedOutAt, email: person.email, externalId: person.externalId }).from(person).where(eq(person.id, personId));
    const [row] = options.lock ? await read.for("update") : await read;
    if (!row) return { answer: "cannot_answer", why: `no person ${personId} is on record`, stops: false };
    if (row.optedOutAt !== null) return { answer: "objected", by: "record", personId };
    // The row's own keys, as erasure gathers them (relations' domain.yaml,
    // `keyColumns`): a profile id is held as `<network>:<id>`.
    if (row.email) keys.push({ kind: "email", value: row.email });
    const cut = row.externalId?.indexOf(":") ?? -1;
    if (row.externalId && cut > 0) keys.push({ kind: "social_profile_id", network: row.externalId.slice(0, cut), value: row.externalId.slice(cut + 1) });
  }
  const asking = keys.filter((k) => typeof k.value === "string" && k.value.trim() !== "");
  if (fingerprints.missing.length > 0) {
    return { answer: "cannot_answer", why: `the register cannot be read: no secret is held for version ${fingerprints.missing.join(", ")} (decision 0063)`, stops: true };
  }
  if (asking.length > 0) {
    // Every chain an entry is keyed under; one, until a rewrap adds one.
    const chains = await db.selectDistinct({ chain: suppression.chain }).from(suppression);
    const sought = new Set<string>();
    for (const { chain } of chains) {
      for (const key of asking) {
        const fingerprint = fingerprints.under(chain, key);
        if (fingerprint === undefined) {
          return { answer: "cannot_answer", why: `the register cannot be read: an entry is keyed under ${chain.join(" → ")}, and a secret of that chain is not held (decision 0063)`, stops: true };
        }
        sought.add(fingerprint);
      }
    }
    if (sought.size > 0) {
      // Served by the unique on the fingerprint.
      const [hit] = await db.select({ id: suppression.id }).from(suppression).where(inArray(suppression.fingerprint, [...sought])).limit(1);
      if (hit) return { answer: "objected", by: "register", ...(personId ? { personId } : {}) };
    }
  }
  return { answer: "none", ...(personId ? { personId } : {}) };
}

/**
 * Whether the person reached us on this channel after `since`: an inbound
 * touch, their own act (decision 0042). What licenses a reactive reply, read
 * by the draft's gate and the message's alike. Reads only; served by the
 * touch index on (person, occurred_at).
 */
export async function engagedSince(db: Database, personId: string, channel: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: touch.id })
    .from(touch)
    .where(and(eq(touch.personId, personId), eq(touch.channel, channel), eq(touch.direction, "inbound"), gt(touch.occurredAt, since)))
    .limit(1);
  return row !== undefined;
}
