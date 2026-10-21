/**
 * Erasure as the domains declare it and the core carries it out (decision
 * 0040, completed by 0049), against a real database with every layer migrated — the only place
 * the declarations of both domains meet the tables they name.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { DomainManifest } from "@werunfoundry/core/manifest/types";
import { validateDomain } from "@werunfoundry/core/manifest/validate";
import { erase, planErasure } from "@werunfoundry/core/runtime/erase";
import { fingerprinter, fingerprintOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import { identityVocabulary } from "@werunfoundry/core/identity";
import type { Database } from "@werunfoundry/core/runtime/run";
import * as relationsSchema from "@werunfoundry/relations/db/schema";
import { recordPerson } from "@werunfoundry/relations/runtime/record";

import type { Contract } from "@werunfoundry/core/contracts/types";
import type { ErasureReach } from "@werunfoundry/core/runtime/erase";
import { ErasureRefused, planBeforeErasure } from "@werunfoundry/core/runtime/erase";
import type { Registry } from "@werunfoundry/core/runtime/resolve";

import type { Sequencer, SequencerDeclaration } from "../contracts/sequencer.js";
import * as acquisitionSchema from "../db/schema.js";
import type { Attested } from "./attest.js";
import { attestStop } from "./attest.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_erasure_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

const relations = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!;
const acquisition = loadDomain(join(import.meta.dirname, "../domain.yaml")).manifest!;

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  for (const layer of ["../../../core", "../../relations", ".."]) {
    const dir = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(dir, f), "utf8"));
  }
  db = drizzle(client) as unknown as Database;
});

after(async () => {
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

beforeEach(async () => {
  // The register refuses a truncate that would destroy an entry (0052); between tests, the triggers are set aside, as only a database's owner can.
  if (client) await client.query("set session_replication_role = replica; truncate relations.person, relations.company, relations.list, core.experiment, core.run cascade; set session_replication_role = origin");
  memory.held.clear();
  memory.answer = undefined;
  memory.failing.clear();
  memory.bare.clear();
  memory.declares = canSuspend();
  memory.calls = 0;
  bound = { sequencer: memorySequencer };
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

/**
 * The sequencer erasure reaches before it forgets anyone (0056): it holds
 * enrolments by their key, lets go of one it withdraws, and reads that back.
 * `answer` makes it fail; `declares` makes it say what it cannot do.
 */
const memory = {
  held: new Map<string, string>(),
  answer: undefined as undefined | "down" | "silent",
  /** Keys whose withdrawal the provider does not answer. */
  failing: new Set<string>(),
  /** Sequences where the person is held by address under no key — a lead the kernel did not put there. */
  bare: new Set<string>(),
  declares: undefined as SequencerDeclaration | undefined,
  calls: 0,
};
const canSuspend = (): SequencerDeclaration => ({
  enrol: { serves: "no", why: "this double does not enrol" },
  pullTouches: { serves: "no", why: "not in this test" },
  suspend: { serves: "yes", method: "letting go of the person", costs: { person: [], sequence: [] }, gap: { known: true, minutes: 0, basis: "by construction", measuredOn: "2026-10-21" } },
  pullUnsubscribes: { serves: "no", why: "not in this test" },
});
const memorySequencer = {
  provider: "memory",
  channels: ["email"],
  get declares() {
    return memory.declares;
  },
  // Found by the key it holds, or — for a sequence in `bare` — by address
  // alone, a lead someone else put there under no key: it says the key its
  // record carries (0060), and none for that one.
  async withdraw({ idempotencyKey, sequenceKey }: { idempotencyKey: string; sequenceKey: string }, ctx: { dryRun: boolean }) {
    memory.calls++;
    const asOf = new Date().toISOString();
    if (memory.answer === "down" || memory.failing.has(idempotencyKey)) return { ok: false, error: { code: "unavailable", message: "the provider did not answer", retryable: true } };
    const bare = memory.bare.has(sequenceKey);
    if (!bare && !memory.held.has(idempotencyKey)) return { ok: true, value: { found: false, asOf } };
    const key = bare ? {} : { idempotencyKey };
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, ...key, asOf } };
    if (bare) memory.bare.delete(sequenceKey);
    else memory.held.delete(idempotencyKey);
    // Answering success and reading nothing back proves nothing (0051).
    return { ok: true, value: memory.answer === "silent" ? { found: true, ...key, asOf } : { found: true, readBack: { sequenceKey, held: false }, ...key, asOf } };
  },
} as unknown as Sequencer;
let bound: Record<string, Contract | undefined> = {};
const registry: Registry = {
  get: (c) => bound[c],
  require: (c) => bound[c] as never,
  forChannel: (c, channel) => (c === "sequencer" && channel === "email" ? (bound.sequencer as never) : undefined),
  all: (c) => (bound[c] ? [bound[c] as never] : []),
  sequence: () => [],
  list: () => [],
};
/** The register's version for these tests: generated, as every secret is (0058). */
const SECRET = generateSecret();
const vocabulary = identityVocabulary([relations, acquisition], ["network_a"]);
/** Resolved for real, from this package: the modules `domain.yaml` names, not ones handed in. */
const reach: ErasureReach = { registry, root: join(import.meta.dirname, ".."), fingerprints: fingerprinter("T1", SECRET, [], vocabulary) };

/** A person named by a row in every table that can name one. */
async function someone(): Promise<string> {
  const [{ id }] = await rows("insert into relations.person (email, full_name) values ('ada@example.com', 'Ada') returning id");
  const [{ id: e }] = await rows("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id");
  const [{ id: run }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', 'system') returning id");
  const [{ id: human }] = await rows("insert into core.run (process_key, trigger, actor_type, actor_id) values ('t', 'manual', 'human', 'an operator') returning id");
  // A list takes its members before its seal; the seal is set after.
  const [{ id: l }] = await rows("insert into relations.list (key, query, actor_type, run_id) values ('l', '{}', 'agent', $1) returning id", [run]);
  await client.query("insert into relations.list_member (list_id, person_id) values ($1, $2)", [l, id]);
  await client.query("update relations.list set sealed_at = now() where id = $1", [l]);
  await client.query("insert into relations.relationship (person_id, status, at, actor_type, actor_id, run_id) values ($1, 'customer', now(), 'human', 'an operator', $2)", [id, human]);
  await client.query("insert into relations.message (key, person_id, channel, body, unsolicited, actor_type) values ('m1', $1, 'email', 'Hello', false, 'human')", [id]);
  await client.query("insert into relations.touch (person_id, channel, direction, unsolicited, sender, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', true, 'a mailbox', 'memory', 't1', now(), 'system')", [id]);
  await client.query("insert into relations.signal (person_id, kind, source, content_hash, occurred_at) values ($1, 'k', 's', 'h', now())", [id]);
  await client.query("insert into acquisition.draft (experiment_id, person_id, step, rendered_body) values ($1, $2, 1, 'Hello')", [e, id]);
  await client.query("insert into acquisition.person_state (person_id, stage, at, actor_type, actor_id, run_id) values ($1, 'engaged', now(), 'human', 'an operator', $2)", [id, human]);
  await client.query("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, provider, actor_type) values ($1, 's', 'email', 'k', 'memory', 'system')", [id]);
  await client.query("insert into acquisition.sourcing_result (run_id, pass, outcome, detail, company, person_id, subject) values ($1, 'person', 'kept', 'd', '{}', $2, 's')", [run, id]);
  return id;
}

const total = async (personId: string) =>
  (await rows(
    `select (select count(*) from relations.list_member where person_id = $1) + (select count(*) from relations.touch where person_id = $1)
      + (select count(*) from relations.relationship where person_id = $1) + (select count(*) from relations.message where person_id = $1)
      + (select count(*) from relations.signal where person_id = $1) + (select count(*) from acquisition.draft where person_id = $1)
      + (select count(*) from acquisition.person_state where person_id = $1) + (select count(*) from acquisition.enrolment where person_id = $1)
      + (select count(*) from acquisition.sourcing_result where person_id = $1) as n`,
    [personId],
  ))[0].n as string;

describe("erasure, as declared", () => {
  it("lets a domain name a step before erasure of its own package only (0056)", () => {
    assert.ok(validateDomain({ ...acquisition }).ok, "acquisition's own declaration is refused");
    const r = validateDomain({ ...relations, beforeErasure: "@werunfoundry/acquisition/runtime/before-erasure" });
    assert.ok(!r.ok && r.issues.some((i) => i.at === "beforeErasure" && /of its own package/.test(i.message)), JSON.stringify(r.issues));
    // A file path, not a package export: refused by its shape, whichever domain names it.
    assert.ok(!validateDomain({ ...relations, beforeErasure: "./runtime/step.ts" }).ok);
  });

  it("has an answer for every table that names a person, in every domain", () => {
    for (const [domain, schema] of [[relations, relationsSchema], [acquisition, acquisitionSchema]] as const) {
      const declared = new Set((domain.erasure ?? []).map((r) => `${r.table}.${r.column}`));
      for (const value of Object.values(schema)) {
        if (!(value instanceof PgTable)) continue;
        const config = getTableConfig(value);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          if (getTableConfig(ref.foreignTable).name !== "person" || getTableConfig(ref.foreignTable).schema !== "relations") continue;
          for (const column of ref.columns) assert.ok(declared.has(`${config.name}.${column.name}`), `${domain.name}: ${config.name}.${column.name} names a person and has no erasure rule`);
        }
      }
    }
    assert.ok(relations.erasure?.some((r) => r.table === "person" && r.column === "id"), "the person's own row has no rule");
  });

  it("reaches by keys every column that holds a person's identity (0049)", () => {
    for (const [domain, schema] of [[relations, relationsSchema], [acquisition, acquisitionSchema]] as const) {
      const declared = new Set((domain.erasure ?? []).flatMap((r) => ("keys" in r && r.keys ? [`${r.table}.${r.keys}`] : [])));
      for (const value of Object.values(schema)) {
        if (!(value instanceof PgTable)) continue;
        const config = getTableConfig(value);
        for (const column of config.columns) {
          if (column.name !== "person" || column.getSQLType() !== "jsonb") continue;
          assert.ok(declared.has(`${config.name}.person`), `${domain.name}: ${config.name}.person holds a person's keys and no rule reaches it by them`);
        }
      }
    }
  });

  it("refuses a row kept with no legal basis", () => {
    const r = validateDomain({ ...relations, erasure: [{ table: "touch", column: "person_id", do: "keep" }] });
    assert.ok(r.issues.some((i) => i.severity === "error" && /erasure/.test(i.at)), JSON.stringify(r.issues));
  });

  // Each from a rule that is otherwise valid, so the refusal is the one rule's.
  const refused = (rule: unknown, why: RegExp) => {
    const r = validateDomain({ ...acquisition, erasure: [rule] });
    assert.ok(r.issues.some((i) => i.severity === "error" && i.at.startsWith("erasure.0") && why.test(i.message)), JSON.stringify(r.issues));
    assert.equal(r.manifest, undefined);
  };
  const valid = { table: "enrolment_skip", keys: "person", do: "anonymise", columns: ["person"] };

  it("accepts an anonymisation reached by keys alone", () => {
    assert.ok(validateDomain({ ...acquisition, erasure: [valid] }).ok);
  });

  it("refuses a rule that reaches its rows by neither id nor keys", () => {
    const { keys: _, ...none } = valid;
    refused(none, /by `column`, by `keys`, or both/);
  });

  it("refuses an anonymisation that changes nothing", () => {
    const { columns: _, ...nothing } = valid;
    refused(nothing, /changes no column/);
  });

  it("refuses a column given two answers", () => {
    refused({ ...valid, random: ["person"] }, /"person" is given two answers/);
  });

  it("refuses a strip path that is an expression, not field names", () => {
    refused({ ...valid, strip: { said: ["key.value}'; drop"] } }, /field names joined by dots/);
  });

  it("refuses keyColumns anywhere but on the subject's own row, and a kind the domain does not declare", () => {
    const r = validateDomain({ ...relations, erasure: [{ table: "touch", column: "person_id", do: "delete", keyColumns: { email: "email" } }] });
    assert.ok(r.issues.some((i) => i.at === "erasure.0.keyColumns" && /own row/.test(i.message)), JSON.stringify(r.issues));
    const k = validateDomain({ ...relations, erasure: [{ table: "person", column: "id", do: "delete", keyColumns: { fax: "email" } }] });
    assert.ok(k.issues.some((i) => i.at === "erasure.0.keyColumns.fax" && /not an identity key/.test(i.message)), JSON.stringify(k.issues));
  });
});

describe("erasing a person", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("shows the plan, upper domains first and the person's own row last, and changes nothing", async () => {
    const id = await someone();
    const plan = await planErasure(db, [relations, acquisition], id);
    assert.deepEqual(plan.map((s) => `${s.domain}.${s.table}:${s.rows}`), [
      "acquisition.draft:1", "acquisition.person_state:1", "acquisition.enrolment:1", "acquisition.sourcing_result:1", "acquisition.enrolment_skip:0",
      "relations.list_member:1", "relations.relationship:1", "relations.message:1", "relations.touch:1", "relations.signal:1", "relations.person:1",
    ]);
    assert.equal(await total(id), "9");
  });

  it("takes the person's own row last, in whatever order its domain lists it", async () => {
    const id = await someone();
    const own = relations.erasure!.find((r) => r.column === "id")!;
    const first: DomainManifest = { ...relations, erasure: [own, ...relations.erasure!.filter((r) => r !== own)] };
    assert.equal((await planErasure(db, [first, acquisition], id)).at(-1)?.table, "person");
  });

  it("does what each domain declares, as a person's run, and deletes the person", async () => {
    const id = await someone();
    const r = await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.equal(await total(id), "0");
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0);
    assert.equal((await rows("select count(*)::int as n from acquisition.sourcing_result"))[0].n, 1, "the run's history stays, naming nobody (0049)");
    assert.equal(r.steps.at(-1)?.outcome, "deleted");
    assert.deepEqual((await rows("select actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0], { actor_type: "human", actor_id: "an operator", status: "succeeded" });
    assert.equal((await rows("select trigger from core.run where id = $1", [r.runId]))[0].trigger, "cli", "the run keeps the channel its caller gave (0048)");
  });

  it("keeps what a domain keeps under its basis, and empties the person it still names instead of deleting it", async () => {
    const id = await someone();
    const keeping: DomainManifest = { ...relations, erasure: relations.erasure!.map((r) => (r.table === "touch" ? { table: "touch", column: "person_id", do: "keep", basis: "an obligation the test invents" } : r)) };
    const r = await erase(db, [keeping, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.equal((await rows("select count(*)::int as n from relations.touch"))[0].n, 1);
    assert.deepEqual(await rows("select email, full_name from relations.person where id = $1", [id]), [{ email: null, full_name: null }]);
    assert.deepEqual(r.steps.map((s) => s.outcome).filter(Boolean), ["kept", "emptied"]);
  });

  it("does all of it or none of it", async () => {
    const id = await someone();
    // An answer the schema refuses — touches are append-only — fails the whole erasure.
    const wrong: DomainManifest = { ...relations, erasure: relations.erasure!.map((r) => (r.table === "touch" ? { table: "touch", column: "person_id", do: "anonymise", columns: ["sender"] } : r)) };
    await assert.rejects(erase(db, [wrong, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach), (e: Error) => /append-only/.test(String((e.cause as Error | undefined)?.message ?? e.message)));
    assert.equal(await total(id), "9");
  });
});

/** The run's fingerprint of a person's keys, as `source.ts` writes it — what anyone holding an address can recompute. */
const fingerprint = (keys: { kind: string; network?: string; value: string }[]) =>
  `person:${createHash("sha256").update(keys.map((k) => `${k.kind}:${k.network ?? ""}:${k.value}`).sort().join("\n")).digest("hex").slice(0, 32)}`;

const ada = {
  email: { kind: "email", value: "ada@example.com" },
  id: { kind: "social_profile_id", network: "network_a", value: "ada-1" },
  handle: { kind: "social_profile_handle", network: "network_a", value: "ada-h" },
};

async function aRun(label: string, dryRun = false): Promise<string> {
  const [{ id }] = await rows("insert into core.run (process_key, trigger, actor_type, dry_run) values ($1, 'cli', 'system', $2) returning id", [label, dryRun]);
  return id;
}

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

async function result(run: string, outcome: string, detail: string, keys: object[] | null, extra: { personId?: string; said?: object; cost?: object } = {}): Promise<string> {
  const [{ id }] = await rows(
    "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, company, person, person_id, said, cost, subject) values ($1, 'person', $2, $3, $4, $5, $6, $7, $8, $9) returning id",
    // As JSON: node-postgres would send an array as a Postgres array.
    [run, outcome, detail, json({ domain: "example.com", name: "An Example" }), json(keys && { subject: "person", keys }), extra.personId ?? null, json(extra.said), json(extra.cost), fingerprint((keys ?? []) as never)],
  );
  return id;
}

const sourcing = async () => rows("select * from acquisition.sourcing_result order by created_at, id");
const counts = async () =>
  (await rows(
    `select (select count(*) from relations.person)::int as person, (select count(*) from acquisition.sourcing_result)::int as sourcing_result,
       (select count(*) from acquisition.enrolment_skip)::int as enrolment_skip, (select count(*) from core.run)::int as run`,
  ))[0];

describe("the reference case — what was done by hand (0049)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("deletes the person, and keeps every history row, naming nobody, by id and by keys", async () => {
    const [{ id }] = await rows("insert into relations.person (email, external_id) values ('ada@example.com', 'network_a:ada-1') returning id");
    await rows("insert into relations.person (email) values ('bob@example.org')");
    const live = await aRun("acquisition.source");
    const later = await aRun("acquisition.source");
    const dry = await aRun("acquisition.source", true);
    // Kept and recorded: names Ada by id, and carries every key, the handle included.
    const kept = await result(live, "kept", "kept and recorded", [ada.email, ada.id, ada.handle], {
      personId: id,
      said: [{ key: ada.email, status: "accepts everything" }],
      cost: [{ provider: "a source", cost: { amount: 1, unit: "credits" } }],
    });
    // Excluded by a later run: names her only by her address, spelt another way, and quotes the CRM's id for her.
    const excluded = await result(later, "known_to_crm", "known to the CRM as crm-0001", [{ kind: "email", value: "ADA@Example.com" }]);
    // A dry run: names her only by the handle, which only the kept row says is hers.
    const simulated = await result(dry, "simulated", "a dry run", [ada.handle]);
    // Bob — and a handle spelt like hers on another network — are not her.
    await result(later, "kept", "kept and recorded", [{ kind: "email", value: "bob@example.org" }]);
    await result(later, "duplicate", "already met in this run", [{ kind: "social_profile_handle", network: "network_b", value: "ada-h" }]);
    await client.query("insert into acquisition.enrolment_skip (run_id, sequence_key, channel, reason, detail, person, company, subject) values ($1, 's', 'email', 'duplicate', 'enrolled already', $2, '{}', 'person:k1')", [later, { subject: "person", keys: [ada.email] }]);
    await client.query("insert into acquisition.enrolment_skip (run_id, sequence_key, channel, reason, detail, person, company, subject) values ($1, 's', 'email', 'duplicate', 'enrolled already', $2, '{}', 'person:k2')", [later, { subject: "person", keys: [{ kind: "email", value: "bob@example.org" }] }]);

    const before = await sourcing();
    const others = before.filter((r) => ![kept, excluded, simulated].includes(r.id));
    const original = before.find((r) => r.id === kept)!.subject;
    assert.equal(original, fingerprint([ada.email, ada.id, ada.handle]), "the fingerprint is testable against keys someone holds");
    assert.deepEqual(await counts(), { person: 2, sourcing_result: 5, enrolment_skip: 2, run: 3 });

    const plan = await planErasure(db, [relations, acquisition], id);
    assert.deepEqual(plan.filter((s) => s.keys).map((s) => `${s.table}:${s.rows}/${s.byKeys}`), ["sourcing_result:3/2", "enrolment_skip:1/1"]);
    assert.deepEqual(await sourcing(), before, "the plan changes nothing");

    const r = await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.equal(r.steps.at(-1)?.outcome, "deleted", "nothing points at the person any more: the row is deleted, not emptied");
    assert.deepEqual(await counts(), { person: 1, sourcing_result: 5, enrolment_skip: 2, run: 4 });

    const after = await sourcing();
    for (const was of before.filter((r) => [kept, excluded, simulated].includes(r.id))) {
      const now = after.find((r) => r.id === was.id)!;
      // What happened stays: the run, the company targeted, the outcome, the times, the cost.
      for (const column of ["run_id", "pass", "outcome", "company", "cost", "created_at"]) assert.deepEqual(now[column], was[column], `${column} changed`);
      // Who it was about does not.
      assert.equal(now.person_id, null);
      assert.equal(now.person, null);
      assert.equal(now.detail, "erased (decision 0049); the outcome stands");
      assert.match(now.subject, /^erased:[0-9a-f-]{36}$/);
    }
    assert.deepEqual(after.find((r) => r.id === kept)!.said, [{ key: { kind: "email" }, status: "accepts everything" }], "the provider's status stays, the address does not");
    assert.equal(new Set(after.map((r) => r.subject)).size, 5, "a value derived from nothing is not shared by two rows");
    const hers = after.filter((r) => [kept, excluded, simulated].includes(r.id));
    // Nothing in her rows names her: no key of hers, in any case, nor the CRM's
    // id for her. Checked value by value, not on the JSON, and not on the
    // random UUIDs — ids, and the subjects checked above as derived from
    // nothing — which can spell "ada", or "ada-1" across a hyphen.
    const naming = [ada.email.value, ada.id.value, ada.handle.value, "crm-0001"];
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
    const random = /^(erased:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const left = strings(hers).filter((s) => !random.test(s) && naming.some((k) => s.toLowerCase().includes(k.toLowerCase())));
    assert.deepEqual(left, [], JSON.stringify(hers));
    assert.ok(!after.some((r) => before.some((b) => b.subject === r.subject && b.id !== r.id)));
    assert.deepEqual(after.filter((r) => ![kept, excluded, simulated].includes(r.id)), others, "nobody else's row changed");

    const skips = await rows("select person, subject, detail, reason from acquisition.enrolment_skip order by subject");
    assert.deepEqual(skips.find((s) => s.subject === "person:k2"), { person: { subject: "person", keys: [{ kind: "email", value: "bob@example.org" }] }, subject: "person:k2", detail: "enrolled already", reason: "duplicate" });
    const erased = skips.find((s) => s.subject !== "person:k2")!;
    assert.deepEqual([erased.person, erased.detail, erased.reason], [null, "erased (decision 0049); the reason stands", "duplicate"]);
    assert.match(erased.subject, /^erased:/);
  });

  it("reaches by the person's own keys rows no row by id leads to: the address, and the profile id held as network:value", async () => {
    const [{ id }] = await rows("insert into relations.person (email, external_id) values ('ada@example.com', 'network_a:ada-1') returning id");
    const run = await aRun("acquisition.source");
    await result(run, "opted_out", "opted out", [ada.email]);
    await result(run, "protected", "an address it already had is on a protected domain", [ada.id]);
    const r = await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.equal(r.steps.find((s) => s.table === "sourcing_result")?.byKeys, 2);
    assert.deepEqual((await sourcing()).map((s) => s.person), [null, null]);
  });

  it("keeps the opt-out as a fingerprint, which nothing reads yet: a person found again is a new person, contactable until 0055's reader (0052)", async () => {
    const [{ id }] = await rows("insert into relations.person (email, opted_out_at) values ('ada@example.com', now()) returning id");
    const r = await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.deepEqual(await rows("select fingerprint, chain from relations.suppression"), [{ fingerprint: fingerprintOf(SECRET, ada.email, vocabulary), chain: ["T1"] }]);
    assert.deepEqual(r.during, [{ domain: "relations", acts: [{ what: "entries written in the register, one per key of a person who objected (decision 0052)", rows: 1 }] }]);
    // The hole 0049 named stays open on the reading side: 0055's reader is not built.
    const again = await recordPerson(db, { subject: "person", keys: [ada.email] });
    assert.ok("id" in again && again.id !== id);
    assert.deepEqual(await rows("select opted_out_at from relations.person"), [{ opted_out_at: null }]);
  });
});

/* -------------------------------------------------------------------------- */
/* An enrolment is history once its person is erased (decision 0053)            */
/* -------------------------------------------------------------------------- */

describe("an enrolment, once its person is erased (0053)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const MARK = { erased: "decision 0053" };
  /** The key `enrol.ts` gives the provider: a hash of the person's keys. */
  const keyOf = (email: string, sequence: string) => createHash("sha256").update([sequence, "email", `email::${email}`].join("\n")).digest("hex").slice(0, 32);

  /**
   * Ada in three sequences: enrolled, refused with the provider's words about
   * her, and suspended with a read-back that names her in clear — what a
   * provider's lead record returns.
   */
  async function enrolled(): Promise<{ id: string; suspendedBy: string }> {
    const [{ id }] = await rows("insert into relations.person (email, external_id, full_name) values ('ada@example.com', 'network_a:ada-1', 'Ada') returning id");
    const [{ id: company }] = await rows("insert into relations.company (domain, name) values ('example.com', 'Example') returning id");
    const suspendedBy = await aRun("acquisition.suspend");
    const row = (sequence: string, state: string, refusal: string | null = null) =>
      rows(
        "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, refusal, actor_type) values ($1, $2, $3, 'email', $4, $5, 'memory', $6, 'system') returning id",
        [id, company, sequence, keyOf("ada@example.com", sequence), state, refusal],
      );
    await row("welcome", "enrolled");
    await row("nurture", "refused", "invalid: ada@example.com is not deliverable");
    const [{ id: suspended }] = await row("winback", "enrolled");
    await client.query(
      `update acquisition.enrolment set state = 'suspended', suspension_asked_at = '2026-10-20T07:34:23Z', suspension_run_id = $2,
         suspension_read_back = $3, suspension_method = 'parking the person in a far-off step',
         suspension_costs = '{"person":["provider_status_stays_active"],"sequence":["shared_state_changes"]}'
       where id = $1`,
      [suspended, suspendedBy, { state: "active", lead: { email: "ada@example.com", id: "lead-1", first_name: "Ada" } }],
    );
    return { id, suspendedBy };
  }
  const enrolments = async () =>
    rows(
      `select sequence_key, person_id, company_id is not null as company, state, idempotency_key, refusal, suspension_asked_at, suspension_run_id,
              suspension_read_back, suspension_method, suspension_costs, provider
         from acquisition.enrolment order by sequence_key`,
    );

  it("keeps every enrolment row, naming nobody: the suspension stays as the proof that it happened", async () => {
    const { id, suspendedBy } = await enrolled();
    const r = await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    assert.deepEqual([r.steps.find((s) => s.table === "enrolment")?.do, r.steps.find((s) => s.table === "enrolment")?.rows], ["anonymise", 3]);
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0, "the person is still on record");
    const after = await enrolments();
    assert.deepEqual(after.map((e) => [e.sequence_key, e.person_id, e.company, e.state]), [
      ["nurture", null, true, "refused"],
      ["welcome", null, true, "enrolled"],
      ["winback", null, true, "suspended"],
    ]);
    const winback = after.find((e) => e.sequence_key === "winback")!;
    assert.deepEqual(
      [winback.suspension_asked_at.toISOString(), winback.suspension_run_id, winback.suspension_method, winback.suspension_costs.sequence],
      ["2026-10-20T07:34:23.000Z", suspendedBy, "parking the person in a far-off step", ["shared_state_changes"]],
      "the suspension's record did not survive the erasure",
    );
  });

  it("leaves nothing of her: not the read-back, not the provider's refusal, not the key derived from her keys", async () => {
    const { id } = await enrolled();
    await erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
    const after = await enrolments();
    const byKey = Object.fromEntries(after.map((e) => [e.sequence_key, e]));
    assert.deepEqual(byKey.winback.suspension_read_back, MARK);
    assert.equal(byKey.nurture.refusal, "erased (decision 0053); the provider's answer is not kept");
    // `text` writes only where there was something (0053): no invented refusal, no read-back on a row that was never suspended.
    assert.deepEqual([byKey.welcome.refusal, byKey.welcome.suspension_read_back, byKey.nurture.suspension_read_back], [null, null, null]);
    for (const e of after) assert.match(e.idempotency_key, /^erased:[0-9a-f-]{36}$/);
    assert.equal(new Set(after.map((e) => e.idempotency_key)).size, 3, "a value derived from nothing is not shared by two rows");
    // Value by value, as 0049's reference case checks: nothing names her, and no key derived from hers is left.
    const naming = ["ada@example.com", "ada-1", "lead-1", "Ada", keyOf("ada@example.com", "welcome"), keyOf("ada@example.com", "nurture"), keyOf("ada@example.com", "winback")];
    const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : v instanceof Date ? [] : v && typeof v === "object" ? [...Object.keys(v), ...Object.values(v).flatMap(strings)] : []);
    const left = strings(after).filter((s) => naming.some((k) => s.includes(k)));
    assert.deepEqual(left, [], JSON.stringify(after));
  });

  it("does not let a suspended row's read-back change but as the erasure writes it", async () => {
    await enrolled();
    await assert.rejects(
      client.query("update acquisition.enrolment set suspension_read_back = $1 where sequence_key = 'winback'", [MARK]),
      /a suspended enrolment is terminal/,
      "the read-back was replaced without the person leaving",
    );
    await assert.rejects(
      client.query("update acquisition.enrolment set person_id = null, suspension_read_back = '{\"erased\": \"something else\"}' where sequence_key = 'winback'"),
      /a suspended enrolment is terminal/,
      "the read-back was replaced by another document than the erasure's",
    );
  });

  // The circumstance, not the writer: an enrolment loses its person only once
  // that person is erased. Each fixture is a row no other check refuses — an
  // enrolled row, which 0051's trigger does not freeze, and an insert that is
  // valid but for its person — so that only this guard can.
  it("does not let a row lose its person while that person still has a key", async () => {
    await enrolled();
    await assert.rejects(
      client.query("update acquisition.enrolment set person_id = null where sequence_key = 'welcome'"),
      /loses its person only once that person is erased/,
      "an enrolment was orphaned with its person still on record",
    );
    assert.equal((await rows("select count(*)::int as n from acquisition.enrolment where person_id is null"))[0].n, 0);
  });

  it("does not let a suspended row take the erasure's document while its person still has a key", async () => {
    await enrolled();
    // What 0051's trigger alone let through: the erasure's own document, the person still on record.
    await assert.rejects(
      client.query("update acquisition.enrolment set person_id = null, suspension_read_back = $1 where sequence_key = 'winback'", [MARK]),
      /loses its person only once that person is erased/,
      "a suspended row's read-back was replaced with its person still on record",
    );
    assert.equal((await rows("select count(*)::int as n from acquisition.enrolment where person_id is null"))[0].n, 0);
  });

  it("does not let an enrolment be born naming nobody", async () => {
    await assert.rejects(
      client.query(
        "insert into acquisition.enrolment (sequence_key, channel, idempotency_key, state, provider, actor_type) values ('welcome', 'email', 'k-1', 'enrolled', 'memory', 'system')",
      ),
      /born naming a recorded person/,
      "an enrolment was inserted with no person",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Erasure stops the person before it forgets them (decision 0056)            */
/* -------------------------------------------------------------------------- */

describe("before erasure, the person is stopped at the provider (0056)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const MARK = { erased: "decision 0053" };
  const erasing = (id: string) => erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);

  /** Ada, enrolled in each sequence given, the provider holding those marked held. */
  async function ada(enrolments: { sequence: string; state?: string; held?: boolean; provider?: string }[]): Promise<string> {
    const [{ id }] = await rows("insert into relations.person (email, full_name) values ('ada@example.com', 'Ada') returning id");
    for (const e of enrolments) {
      const key = `key-${e.sequence}`;
      await client.query(
        "insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'email', $3, $4, $5, 'system')",
        [id, e.sequence, key, e.state ?? "enrolled", e.provider ?? "memory"],
      );
      if (e.held !== false) memory.held.set(key, e.sequence);
    }
    return id;
  }
  const enrolments = async () =>
    rows("select sequence_key, state, person_id, suspension_read_back, suspension_method, suspension_attestation, suspension_run_id from acquisition.enrolment order by sequence_key");
  const refusals = async () => rows("select e.sequence_key, r.reason from acquisition.suspension_refusal r join acquisition.enrolment e on e.id = r.enrolment_id order by e.sequence_key");
  const people = async () => (await rows("select count(*)::int as n from relations.person"))[0].n as number;

  it("suspends every enrolment the provider holds before it forgets the person: the anonymised row is the proof", async () => {
    const id = await ada([{ sequence: "welcome" }, { sequence: "winback" }]);
    const r = await erasing(id);
    assert.deepEqual(r.before, [{ domain: "acquisition", acts: [{ what: "enrolments suspended at the provider, read back and recorded", rows: 2, through: "sequencer (memory)" }] }]);
    assert.equal(memory.held.size, 0, "the provider still holds someone the kernel forgot");
    assert.equal(await people(), 0);
    for (const e of await enrolments()) {
      assert.deepEqual([e.state, e.person_id, e.suspension_read_back, e.suspension_method, e.suspension_run_id], ["suspended", null, MARK, "letting go of the person", r.runId]);
    }
  });

  it("asks the provider about a pending row: one it holds is enrolled then suspended, one it does not stays pending", async () => {
    const id = await ada([{ sequence: "held", state: "pending" }, { sequence: "lost", state: "pending", held: false }]);
    await erasing(id);
    assert.deepEqual((await enrolments()).map((e) => [e.sequence_key, e.state]), [["held", "suspended"], ["lost", "pending"]]);
  });

  it("stops by address a pending row whose person the provider holds under no key of the kernel's, and leaves it pending (0060)", async () => {
    const id = await ada([{ sequence: "theirs", state: "pending", held: false }]);
    memory.bare.add("theirs");
    const r = await erasing(id);
    assert.equal(memory.bare.size, 0, "the person was not stopped");
    assert.deepEqual((await enrolments()).map((e) => [e.sequence_key, e.state, e.suspension_read_back]), [["theirs", "pending", null]], "a lead the kernel did not make was written as its suspension");
    assert.deepEqual(r.before[0]!.acts.map((a) => a.what), ["pending enrolments whose person was stopped by address, under no key of the kernel's: left pending, the stop not written on them (0060)"]);
    assert.equal(await people(), 0, "the erasure did not go on");
  });

  it("refuses the erasure when the provider does not answer, naming the adapter and saying retrying is the remedy — and forgets nobody", async () => {
    const id = await ada([{ sequence: "welcome" }]);
    memory.answer = "down";
    await assert.rejects(erasing(id), (e: Error) => e instanceof ErasureRefused && /the sequencer adapter bound as "memory" answered: unavailable: the provider did not answer/.test(e.message) && /Running the erasure again is the remedy/.test(e.message));
    assert.equal(await people(), 1, "the person was erased although they were not stopped");
    assert.deepEqual((await enrolments()).map((e) => [e.state, e.person_id === id]), [["enrolled", true]]);
    assert.deepEqual(await refusals(), [{ sequence_key: "welcome", reason: "unanswered" }]);
    assert.deepEqual(await rows("select status from core.run where process_key = 'relations.person.erase'"), [{ status: "failed" }]);
  });

  it("finishes on a retry, and does not ask again what it already stopped", async () => {
    const id = await ada([{ sequence: "a" }, { sequence: "b" }]);
    memory.failing.add("key-b");
    await assert.rejects(erasing(id), ErasureRefused);
    assert.deepEqual((await enrolments()).map((e) => [e.sequence_key, e.state]), [["a", "suspended"], ["b", "enrolled"]], "what was stopped was not kept");
    memory.failing.clear();
    memory.calls = 0;
    await erasing(id);
    assert.equal(memory.calls, 1, "the retry asked the provider again about the row already stopped");
    assert.equal(await people(), 0);
  });

  it("refuses, saying retrying will not fix it, when no sequencer takes the row's channel", async () => {
    const id = await ada([{ sequence: "welcome" }]);
    bound = {};
    await assert.rejects(erasing(id), (e: Error) => /no sequencer is bound to the channel "email"/.test(e.message) && /will not fix this/.test(e.message) && /kernel-attest-stop/.test(e.message));
    assert.deepEqual(await refusals(), [{ sequence_key: "welcome", reason: "unbound" }]);
    assert.equal(await people(), 1);
  });

  it("refuses when the sequencer bound is not the provider the row was made through", async () => {
    const id = await ada([{ sequence: "welcome", provider: "another-provider" }]);
    await assert.rejects(erasing(id), (e: Error) => /made through "another-provider"/.test(e.message) && /will not fix this/.test(e.message));
    assert.deepEqual(await refusals(), [{ sequence_key: "welcome", reason: "other_provider" }]);
    assert.equal(memory.calls, 0, "a provider was asked to stop what another holds");
  });

  it("refuses when the sequencer declares that it cannot suspend", async () => {
    const id = await ada([{ sequence: "welcome" }]);
    memory.declares = { ...canSuspend(), suspend: { serves: "no", why: "the provider cannot stop one person" } };
    await assert.rejects(erasing(id), (e: Error) => /cannot suspend one person/.test(e.message) && /will not fix this/.test(e.message));
    assert.deepEqual(await refusals(), [{ sequence_key: "welcome", reason: "cannot_suspend" }]);
  });

  it("does not take a success read back as nothing for a stop (0051)", async () => {
    const id = await ada([{ sequence: "welcome" }]);
    memory.answer = "silent";
    await assert.rejects(erasing(id), (e: Error) => /read nothing back/.test(e.message));
    assert.deepEqual((await enrolments()).map((e) => e.state), ["enrolled"]);
  });

  it("is refused when it is given no bound adapters, and forgets nobody", async () => {
    const id = await ada([]);
    // Not `erasing(id, undefined)`: a default parameter takes undefined as absent.
    await assert.rejects(erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }), (e: Error) => e instanceof ErasureRefused && /given no bound adapters/.test(e.message));
    assert.equal(await people(), 1);
  });

  it("plans as dry runs: says what it would stop, and stops nothing", async () => {
    const id = await ada([{ sequence: "welcome" }, { sequence: "gone", held: false }]);
    const plan = await planBeforeErasure(db, [relations, acquisition], id, reach);
    assert.deepEqual(plan, [
      {
        domain: "acquisition",
        result: {
          acts: [
            { what: "enrolments the provider holds nothing of", rows: 1, through: "sequencer (memory)" },
            { what: "enrolments it would suspend", rows: 1, through: "sequencer (memory)" },
          ],
          refused: [],
        },
      },
    ]);
    assert.equal(memory.held.size, 1);
    assert.deepEqual((await enrolments()).map((e) => e.state), ["enrolled", "enrolled"]);
    assert.deepEqual(await refusals(), []);
  });
});

/* -------------------------------------------------------------------------- */
/* A person's attestation, in the four cases only (decision 0056)             */
/* -------------------------------------------------------------------------- */

describe("a person attests a stop, only where retrying cannot help (0056)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const MARK = { erased: "decision 0053" };
  const erasing = (id: string) => erase(db, [relations, acquisition], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: false }, reach);
  async function enrolledAda(): Promise<{ person: string; enrolment: string }> {
    const [{ id }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    const [{ id: e }] = await rows("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'key-welcome', 'enrolled', 'memory', 'system') returning id", [id]);
    memory.held.set("key-welcome", "welcome");
    return { person: id, enrolment: e };
  }
  const attest = (enrolmentId: string, attested: Attested = { kind: "stopped_by_hand", how: "paused her by hand in the provider's interface" }) =>
    attestStop({ db, registry }, { enrolmentId, by: "an operator", attested, trigger: "cli" });
  const row = async (id: string) => (await rows("select state, suspension_read_back, suspension_attestation, suspension_method, suspension_run_id from acquisition.enrolment where id = $1", [id]))[0];

  it("is refused where the sequencer can still suspend and no erasure was refused: retrying is the remedy", async () => {
    const { enrolment } = await enrolledAda();
    const r = await attest(enrolment);
    assert.ok("refused" in r && /no attestation is open/.test(r.refused) && /running it again is the remedy/.test(r.refused), JSON.stringify(r));
    assert.equal((await row(enrolment)).state, "enrolled");
  });

  it("opens where no sequencer takes the channel, and keeps the person's word in its own column — never as a read-back", async () => {
    const { enrolment } = await enrolledAda();
    bound = {};
    const r = await attest(enrolment);
    assert.ok("recorded" in r, JSON.stringify(r));
    const after = await row(enrolment);
    assert.deepEqual([after.state, after.suspension_read_back, after.suspension_method, after.suspension_run_id], ["suspended", null, null, r.runId]);
    assert.deepEqual(after.suspension_attestation, { case: "unbound", kind: "stopped_by_hand", how: "paused her by hand in the provider's interface" });
    assert.deepEqual(await rows("select actor_type, actor_id, process_key from core.run where id = $1", [r.runId]), [{ actor_type: "human", actor_id: "an operator", process_key: "acquisition.enrolment.attest" }]);
  });

  it("opens for a provider that does not answer only once an erasure was refused on it, and the person attests the case", async () => {
    const { person, enrolment } = await enrolledAda();
    memory.answer = "down";
    assert.ok("refused" in (await attest(enrolment, { kind: "account_closed", said: "the provider closed the account" })), "an attestation opened before any refusal");
    await assert.rejects(erasing(person), ErasureRefused);
    const r = await attest(enrolment, { kind: "account_closed", said: "the provider closed the account" });
    assert.ok("recorded" in r && r.case === "unanswered", JSON.stringify(r));
    assert.deepEqual((await row(enrolment)).suspension_attestation, { case: "unanswered", kind: "account_closed", said: "the provider closed the account" });
  });

  it("lets the erasure go on once attested, and anonymises the attestation as it does a read-back", async () => {
    const { person, enrolment } = await enrolledAda();
    bound = {};
    await attest(enrolment);
    await erasing(person);
    const after = await row(enrolment);
    assert.deepEqual([after.state, after.suspension_attestation, after.suspension_read_back], ["suspended", MARK, null]);
  });

  it("holds a suspended row to one record: a read-back or an attestation, never both, never neither", async () => {
    const { enrolment } = await enrolledAda();
    const suspend = (set: string) => client.query(`update acquisition.enrolment set state = 'suspended', suspension_asked_at = now(), ${set} where id = $1`, [enrolment]);
    await assert.rejects(suspend(`suspension_read_back = '{"held": false}', suspension_method = 'm', suspension_costs = '{"person": [], "sequence": []}', suspension_attestation = '{"kind": "stopped_by_hand"}'`), /enrolment_suspension_recorded/);
    await assert.rejects(suspend("suspension_method = 'm'"), /enrolment_suspension_recorded/);
    await assert.rejects(suspend(`suspension_attestation = '{"kind": "stopped_by_hand"}', suspension_method = 'm'`), /enrolment_suspension_recorded/);
    assert.equal((await row(enrolment)).state, "enrolled");
  });

  it("stops a pending row as it stands, never through enrolled (0060)", async () => {
    const [{ id: person }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    const [{ id: enrolment }] = await rows("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'key-welcome', 'pending', 'memory', 'system') returning id", [person]);
    bound = {};
    // Every move the row makes, as the database sees it: what the attestation writes on the way, not only where it ends.
    await client.query("create table if not exists public.moves (from_state text, to_state text)");
    await client.query("truncate public.moves");
    await client.query(`create or replace function public.log_move() returns trigger language plpgsql as $$ begin insert into public.moves values (OLD.state::text, NEW.state::text); return NEW; end $$`);
    await client.query("drop trigger if exists log_move on acquisition.enrolment");
    await client.query("create trigger log_move after update of state on acquisition.enrolment for each row execute function public.log_move()");
    try {
      const r = await attest(enrolment);
      assert.ok("recorded" in r, JSON.stringify(r));
      assert.deepEqual(await rows("select from_state, to_state from public.moves"), [{ from_state: "pending", to_state: "suspended" }], "the attestation wrote a provider's confirmation nobody gave");
    } finally {
      await client.query("drop trigger if exists log_move on acquisition.enrolment");
    }
  });

  it("freezes an attested row's attestation, as it freezes a read-back (0051)", async () => {
    const { enrolment } = await enrolledAda();
    bound = {};
    await attest(enrolment);
    await assert.rejects(client.query(`update acquisition.enrolment set suspension_attestation = '{"kind": "account_closed"}' where id = $1`, [enrolment]), /a suspended enrolment is terminal/);
  });
});
