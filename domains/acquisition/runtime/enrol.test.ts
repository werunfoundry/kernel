/**
 * Tests for the enrolment path.
 *
 * The adapters are in memory, and that is a seam: CLAUDE.md §5 says what it
 * hides. The crossing — the template's example adapters, installed from the
 * packs, driven by the kernel's own command on plain Node — is try-instance.
 * What this file pins is the logic, and above all protection, against a real
 * database: every run is recorded, and every test reads the row.
 *
 * Each protection test asserts on what the sequencer *holds*, not only on the
 * report. A report can say "protected" while the enrolment went through; the
 * sequencer's state cannot.
 *
 * Every enrolment is from a sealed list and carries its messages (0064 §1):
 * `seed` records the list's companies and people, seals the list, and gives
 * each person an approved draft for the sequence's one step. What carrying
 * the messages adds — the gate, the steps, the cap — is pinned in
 * `enrol-from-list.test.ts`; this file pins everything else a run does.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Fingerprinter } from "@werunfoundry/core/runtime/fingerprint";
import { fingerprinter, fingerprintOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import { constituteList } from "@werunfoundry/relations/runtime/list";

import type { CapacityLimit, Sequencer, SequencerDeclaration } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetList } from "../contracts/target-list.js";
import type { EnrolRequest } from "./enrol.js";
import { acknowledgeUncovered, withdrawAcknowledgement } from "./acknowledge.js";
import { approve, propose } from "./draft.js";
import { CannotSuspend, enrol, ErasedWithoutRegister } from "./enrol.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_enrol_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  // The three layers, in dependency order: the registry lives in acquisition and
  // points into relations.
  for (const layer of ["../../../core", "../../relations", ".."]) {
    const migrations = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrations, f), "utf8"));
    }
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

/* -------------------------------------------------------------------------- */
/* An instance's world, in memory                                              */
/* -------------------------------------------------------------------------- */

const NOW = new Date("2026-06-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** A company on the list, as `relations` records it, with its people. */
interface Listed {
  domain?: string;
  /** Its id on a network, as `relations` keeps one: `network:value`. */
  externalId?: string;
  people: { email: string; name: string; externalId?: string }[];
}

const world = {
  /** The list's people, company by company. `seed` records them. */
  listed: [] as Listed[],
  /** Companies on the list as companies, naming nobody. */
  listedCompanies: [] as string[],
  protected: [] as ProtectedAccount[],
  protectedAsOf: minutesAgo(5),
  /** When set, the named read fails. */
  failing: new Set<string>(),
  /** Protected accounts split across pages of this size. */
  pageSize: 100,
  /** What the sequencer holds: key → email. A dry run never writes here. */
  enrolled: new Map<string, string>(),
  /**
   * Leads someone else put in the sequence — a colleague, another tool:
   * email → the key their record carries, if any. The provider keeps one lead
   * per person per sequence, so enrolling one of them is a conflict (0011).
   */
  foreign: new Map<string, string | undefined>(),
  enrolCalls: 0,
  statusCalls: 0,
  /** The idempotency key of every enrol call, in order. */
  keysSent: [] as string[],
  /**
   * How the next enrol call fails: `after` holds the person and then fails —
   * a timeout after the provider acted; `before` fails without holding;
   * `refuse` answers invalid.
   */
  crash: undefined as "after" | "before" | "refuse" | undefined,
  remaining: 100,
  /** What the sequencer reports as its limits; by default one, from `remaining`. */
  limits: (): CapacityLimit[] => [{ unit: "messages", window: "day", remaining: world.remaining }],
};

const ok = <T>(value: T): CallResult<T> => ({ ok: true, value });
const down = <T>(what: string): CallResult<T> => ({ ok: false, error: { code: "unavailable", message: `${what} is down`, retryable: true } });

const targetList: TargetList = {
  provider: "memory-targets",
  async freshness(route) {
    if (world.failing.has("freshness")) return down("freshness");
    return ok({ route, asOf: route === "protected" ? world.protectedAsOf : minutesAgo(1) });
  },
  async candidates() {
    throw new Error("an enrolment takes its people from a list, never from the target list's candidates");
  },
  async protectedAccounts(query) {
    const start = Number(query.cursor ?? 0);
    if (world.failing.has(`protected-page-${start}`)) return down("the protected set");
    const items = world.protected.slice(start, start + world.pageSize);
    const next = start + world.pageSize;
    return ok({ items, ...(next < world.protected.length ? { nextCursor: String(next) } : {}) });
  },
};

const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value ?? "";

/** A sequencer that can suspend (0051), as every test but the refusal's assumes. */
const canSuspend = (): SequencerDeclaration => ({
  enrol: { serves: "yes" },
  pullTouches: { serves: "no", why: "not in this test" },
  suspend: {
    serves: "yes",
    method: "parking the person in a far-off step",
    costs: { person: ["provider_status_stays_active"], sequence: ["shared_state_changes"] },
    gap: { known: false, why: "never measured" },
  },
  pullUnsubscribes: { serves: "no", why: "not in this test" },
  readSteps: { serves: "yes" },
});
let declared: SequencerDeclaration | undefined = canSuspend();

const sequencer: Sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  get declares() {
    return declared;
  },
  // One step, which renders the subject and the body the kernel wrote.
  async readSteps(sequenceKey) {
    return ok({ sequenceKey, steps: [{ step: 1, channel: "email", afterPreviousMinutes: 0, subject: { variable: "engine_subject_1" }, body: { variable: "engine_body_1" }, variants: 1 }], asOf: NOW.toISOString() });
  },
  async enrol(e, ctx) {
    world.enrolCalls++;
    world.keysSent.push(e.idempotencyKey);
    const crash = world.crash;
    world.crash = undefined;
    if (crash === "refuse") return { ok: false, error: { code: "invalid", message: "this address cannot be sequenced", retryable: false } };
    if (crash === "before") return down("the sequencer");
    if (crash === "after") {
      if (!ctx.dryRun) world.enrolled.set(e.idempotencyKey, emailOf(e.person));
      return down("the sequencer");
    }
    if (world.foreign.has(emailOf(e.person))) return { ok: false, error: { code: "conflict", message: "this person is already in that sequence, enrolled outside this engine", retryable: false } };
    const held = world.enrolled.get(e.idempotencyKey);
    if (!held && !ctx.dryRun) world.enrolled.set(e.idempotencyKey, emailOf(e.person));
    return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { state: "active", idempotencyKey: e.idempotencyKey, asOf: NOW.toISOString() } };
  },
  // Held to its declaration (0054): it parks the person by letting go of
  // them, so that a test can see the suspension it declares.
  async withdraw({ idempotencyKey }, ctx) {
    const held = world.enrolled.get(idempotencyKey);
    if (!held) return ok({ found: false, asOf: NOW.toISOString() });
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, asOf: NOW.toISOString() } };
    world.enrolled.delete(idempotencyKey);
    return ok({ found: true, readBack: { state: "parked", email: held }, idempotencyKey, asOf: NOW.toISOString() });
  },
  async suppress() {
    return ok({ applied: [], notApplicable: [], asOf: NOW.toISOString() });
  },
  // Found by address, as a provider finds a lead, and says the key its
  // record carries (0060) — none for a lead someone else put there bare.
  async status({ person }) {
    world.statusCalls++;
    const email = emailOf(person);
    if (world.foreign.has(email)) {
      const key = world.foreign.get(email);
      return ok({ state: "active", ...(key ? { idempotencyKey: key } : {}), asOf: NOW.toISOString() });
    }
    const key = [...world.enrolled.entries()].find(([, e]) => e === email)?.[0];
    return ok({ state: key ? "active" : "unknown", ...(key ? { idempotencyKey: key } : {}), asOf: NOW.toISOString() });
  },
  async capacity({ sender, channel }) {
    return world.failing.has("capacity")
      ? down("capacity")
      : ok({ sender, channel, limits: world.limits(), asOf: NOW.toISOString() });
  },
};

const registry: Registry = {
  get: (c) => ({ target_list: targetList } as Record<string, Contract>)[c],
  require: () => {
    throw new Error("not used");
  },
  forChannel: <T extends Contract>(c: string, ch: string) => (c === "sequencer" && ch === "email" ? (sequencer as unknown as T) : undefined),
  all: <T extends Contract>(c: string) => (c === "sequencer" ? [sequencer as unknown as T] : []),
  sequence: () => [],
  list: () => [],
};

// The real relations domain.yaml, so the vocabulary is the one an instance gets.
const relationsDomain = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest;
if (!relationsDomain) throw new Error("relations/domain.yaml does not load");
const identity = identityVocabulary([relationsDomain], ["net_a"]);
/** The register's secret, under one version (0055). */
const SECRET = generateSecret();
const register = fingerprinter("T1", { T1: SECRET }, [], identity);

/* The list, recorded and sealed, and a draft approved for each person ------- */

const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];
const human = { actor: { type: "human" as const, id: "an operator" } };

/** The campaign the list's drafts belong to, made once per test. */
let campaign: { experimentId: string; templateId: string } | undefined;
/** The people who already have an approved draft in this test. */
let drafted = new Set<string>();

/** A row of `relations`, found by its unique key or recorded. */
async function recorded(table: "company" | "person", key: { column: string; value: string }, values: Record<string, unknown>): Promise<string> {
  const found = await one(`select id from relations.${table} where lower(${key.column}) = lower($1)`, [key.value]);
  if (found) return found.id as string;
  const columns = Object.keys(values);
  return (await one(`insert into relations.${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(values))).id as string;
}

/**
 * Records `world.listed` and seals it as `listKey`, each person with an
 * approved draft. Returns the experiment. Once per list: a list constituted
 * again under its key keeps its first members (`constituteList`).
 */
async function seed(listKey = "the-list"): Promise<string> {
  campaign ??= await (async () => {
    const experimentId = (await one("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('exp-enrol', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).id as string;
    const templateId = (await one("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'Hello', 'One.') returning id", [experimentId])).id as string;
    return { experimentId, templateId };
  })();
  const members: ({ personId: string } | { companyId: string })[] = [];
  for (const c of world.listed) {
    const companyId = c.domain
      ? await recorded("company", { column: "domain", value: c.domain }, { name: c.domain, domain: c.domain, external_id: c.externalId ?? null })
      : undefined;
    for (const p of c.people) {
      const personId = await recorded("person", { column: "email", value: p.email }, { email: p.email, full_name: p.name, company_id: companyId ?? null, external_id: p.externalId ?? null });
      members.push({ personId });
      if (drafted.has(personId)) continue;
      const proposed = await propose(db, register, { experimentId: campaign.experimentId, personId, step: 1, templateId: campaign.templateId, renderedSubject: `Hello ${p.name}`, renderedBody: `For ${p.name}.` }, { actor: { type: "agent", id: "a drafting agent" } }, { autonomyAfter: 5 });
      assert.ok(proposed.ok, JSON.stringify(proposed));
      assert.ok((await approve(db, proposed.draft.id, { by: "an operator" }, human)).ok);
      drafted.add(personId);
    }
  }
  for (const domain of world.listedCompanies) members.push({ companyId: await recorded("company", { column: "domain", value: domain }, { name: domain, domain }) });
  const listRun = (await one("insert into core.run (process_key, trigger, actor_type, actor_id, dry_run) values ('acquisition.list.constitute', 'cli', 'human', 'an operator', false) returning id")).id as string;
  await constituteList(db, { key: listKey, query: { from: "hand" }, members, actor: human.actor, runId: listRun });
  return campaign.experimentId;
}

const request = (experimentId: string, over: Partial<EnrolRequest> = {}): EnrolRequest => ({
  sequenceKey: "welcome",
  channel: "email",
  fromList: { listKey: "the-list", experimentId, unsolicited: false },
  protectedMaxAgeMinutes: 60,
  dryRun: false,
  trigger: "cli",
  actor: { type: "system", id: "test" },
  ...over,
});

/** A run from the list, seeded first; `list` names another list, seeded from `world.listed` as it then stands. */
const run = async (over: Partial<EnrolRequest> = {}, opts: { fingerprints?: Fingerprinter; list?: string } = {}) => {
  const experimentId = await seed(opts.list);
  const r = request(experimentId, over);
  return enrol({ db, registry, identity, fingerprints: opts.fingerprints ?? register, now: () => NOW }, opts.list ? { ...r, fromList: { ...r.fromList, listKey: opts.list } } : r);
};

const row = async (id: string) =>
  (await client.query("select status, dry_run, error from core.run where id = $1", [id])).rows[0] as {
    status: string;
    dry_run: boolean;
    error: string | null;
  };

const held = () => [...world.enrolled.values()].sort();

beforeEach(async () => {
  if (client) {
    await client.query(
      "truncate acquisition.enrolment_skip, acquisition.enrolment, acquisition.draft, acquisition.template, acquisition.protection_acknowledgement, relations.message, relations.list, relations.person, relations.company, core.experiment cascade",
    );
  }
  campaign = undefined;
  drafted = new Set();
  world.statusCalls = 0;
  world.keysSent = [];
  world.crash = undefined;
  world.listed = [
    { domain: "open.example.com", people: [{ email: "ada@open.example.com", name: "Ada" }, { email: "bo@open.example.com", name: "Bo" }] },
    // Cy's address is on another domain: only the account's own protection
    // can stop Cy, which is what the first test is about.
    { domain: "customer.example.org", people: [{ email: "cy@cy-consulting.example.net", name: "Cy" }] },
  ];
  world.listedCompanies = [];
  world.protected = [{ domain: "customer.example.org", reason: "customer" }];
  world.protectedAsOf = minutesAgo(5);
  world.failing = new Set();
  world.pageSize = 100;
  world.enrolled = new Map();
  world.foreign = new Map();
  world.enrolCalls = 0;
  world.remaining = 100;
  world.limits = () => [{ unit: "messages", window: "day", remaining: world.remaining }];
  declared = canSuspend();
});

/* -------------------------------------------------------------------------- */

describe("the enrolment path", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("enrols the open account's people and never the protected account's", async () => {
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
    assert.ok(!held().includes("cy@cy-consulting.example.net"), "a protected account's person was enrolled");
    assert.deepEqual(r.skipped.map((s) => [s.reason, s.company.domain]), [["protected", "customer.example.org"]]);
    assert.equal((await row(r.runId)).status, "succeeded");
  });

  it("protects a person whose address is on a protected domain, even listed under another company", async () => {
    world.listed[0]!.people = [{ email: "dee@customer.example.org", name: "Dee" }, { email: "ada@open.example.com", name: "Ada" }];
    const r = await run();
    assert.deepEqual(held(), ["ada@open.example.com"]);
    assert.ok(r.skipped.some((s) => s.reason === "protected" && s.person && emailOf(s.person) === "dee@customer.example.org"));
  });

  describe("when protection cannot answer, nobody is enrolled and the run says why", () => {
    const blocked = async (setup: () => void, why: RegExp) => {
      setup();
      const r = await run();
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", why);
      assert.equal(world.enrolCalls, 0, "an enrolment was attempted");
      assert.deepEqual(held(), []);
      const recorded = await row(r.runId);
      assert.equal(recorded.status, "failed");
      assert.match(recorded.error ?? "", /protection unavailable/);
    };

    it("its age cannot be read", () => blocked(() => world.failing.add("freshness"), /age could not be read/));
    it("it is older than allowed", () => blocked(() => (world.protectedAsOf = minutesAgo(61)), /61 minutes old, older than the 60 allowed/));
    it("its age is not a time", () => blocked(() => (world.protectedAsOf = "last tuesday"), /not a time/));
    it("a later page fails", () =>
      blocked(() => {
        world.pageSize = 1;
        world.protected = [...world.protected, { domain: "other.example.org", reason: "partner" }];
        world.failing.add("protected-page-1");
      }, /could not be read to its last page/));
    it("an account has nothing to match it by", () =>
      blocked(() => world.protected.push({ name: "Somebody", reason: "do_not_contact" }), /neither a domain, a company id nor an identifier/));
  });

  it("writes nothing in a dry run, and records the run as one", async () => {
    const r = await run({ dryRun: true });
    assert.equal(r.status, "succeeded");
    assert.equal(r.enrolled.length, 2, "a dry run reports what it would enrol");
    assert.deepEqual(held(), []);
    assert.equal((await row(r.runId)).dry_run, true);
  });

  it("does not enrol anyone twice when replayed", async () => {
    await run();
    const again = await run();
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
    assert.equal(again.enrolled.length, 0);
    assert.deepEqual(again.skipped.filter((s) => s.reason === "duplicate").length, 2);
  });

  it("keeps the reasons apart: protected, capacity and duplicate are never the same skip", async () => {
    world.enrolled.set("seeded", "bo@open.example.com"); // already in the sequence
    world.listed[0]!.people = [
      { email: "bo@open.example.com", name: "Bo" },
      { email: "ada@open.example.com", name: "Ada" },
      { email: "fay@open.example.com", name: "Fay" },
    ];
    world.remaining = 1;
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.person ? emailOf(s.person) : s.company.domain, s.reason]));
    assert.deepEqual(reasons, {
      "bo@open.example.com": "duplicate",
      "fay@open.example.com": "capacity",
      "customer.example.org": "protected",
    });
    assert.deepEqual(r.capacity, { checked: true, budget: 1 });
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
  });

  it("says capacity was not checked when no sender was given, rather than assuming it", async () => {
    const r = await run();
    assert.deepEqual(r.capacity, { checked: false, why: "no sender was given" });
  });

  it("stops, rather than calling it zero, when a provider does not say what capacity is left", async () => {
    const original = sequencer.capacity;
    sequencer.capacity = async ({ sender, channel }) =>
      ok({ sender, channel, limits: [{ unit: "messages", window: "day" as const }], asOf: NOW.toISOString() });
    try {
      const r = await run({ senders: [{ externalId: "sender@example.com" }] });
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", /did not say what is left/);
      assert.equal(world.enrolCalls, 0);
    } finally {
      sequencer.capacity = original;
    }
  });

  it("plans against the tightest limit when a sender carries several", async () => {
    // A generous daily pace, and a weekly ceiling with one left.
    world.limits = () => [
      { unit: "invitations", window: "day", remaining: 20 },
      { unit: "invitations", window: "week", remaining: 1 },
    ];
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    assert.deepEqual(r.capacity, { checked: true, budget: 1 });
    assert.equal(r.enrolled.length, 1);
    assert.equal(r.skipped.filter((s) => s.reason === "capacity").length, 1);
  });

  it("treats a limit that does not say what is left as unknown, even beside one that does", async () => {
    world.limits = () => [
      { unit: "messages", window: "day", remaining: 50 },
      { unit: "messages", window: "week" },
    ];
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /did not say what is left of its week limit/);
    assert.equal(world.enrolCalls, 0);
  });

  it("records every run it opens, and says so", async () => {
    const r = await run();
    assert.equal(r.recorded, true);
  });

  it("stops before enrolling when capacity cannot be read", async () => {
    world.failing.add("capacity");
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    assert.equal(r.status, "failed");
    assert.equal(world.enrolCalls, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The registry (decision 0026)                                                */
/* -------------------------------------------------------------------------- */

describe("the registry", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const registered = async () =>
    (
      await client.query(
        `select p.email, e.state, e.sequence_key, e.channel, e.idempotency_key, e.provider, e.run_id, e.refusal, c.domain as company
           from acquisition.enrolment e join relations.person p on p.id = e.person_id left join relations.company c on c.id = e.company_id
          order by p.email`,
      )
    ).rows as { email: string; state: string; sequence_key: string; channel: string; idempotency_key: string; provider: string; run_id: string; refusal: string | null; company: string | null }[];
  const skips = async (runId: string) =>
    (await client.query("select reason, subject, detail from acquisition.enrolment_skip where run_id = $1 order by subject", [runId])).rows as {
      reason: string;
      subject: string;
      detail: string;
    }[];

  it("records who was enrolled, in which sequence, through which company, by which run", async () => {
    const r = await run();
    const rows = await registered();
    assert.deepEqual(
      rows.map((x) => [x.email, x.state, x.sequence_key, x.channel, x.provider, x.company, x.run_id === r.runId]),
      [
        ["ada@open.example.com", "enrolled", "welcome", "email", "memory-sequencer", "open.example.com", true],
        ["bo@open.example.com", "enrolled", "welcome", "email", "memory-sequencer", "open.example.com", true],
      ],
    );
    // The key the provider was given is the key on record.
    assert.deepEqual(rows.map((x) => x.idempotency_key).sort(), [...world.keysSent].sort());
  });

  it("writes no registry row and no message in a dry run, and still keeps its skips", async () => {
    const r = await run({ dryRun: true });
    assert.equal(r.enrolled.length, 2);
    assert.deepEqual(await registered(), []);
    assert.equal((await client.query("select count(*)::int as n from relations.message")).rows[0].n, 0);
    assert.deepEqual((await skips(r.runId)).map((s) => s.reason), ["protected"]);
  });

  it("answers a replay from the registry, without asking the provider", async () => {
    await run();
    const statusBefore = world.statusCalls;
    const again = await run();
    assert.equal(again.enrolled.length, 0);
    assert.deepEqual(again.skipped.filter((s) => s.reason === "duplicate").map((s) => s.detail), [
      "already enrolled in this sequence, by the registry",
      "already enrolled in this sequence, by the registry",
    ]);
    assert.equal(world.statusCalls, statusBefore, "the provider was asked what the registry already knew");
  });

  it("is written before the provider is called: a run that dies after the provider acted leaves it pending", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "after";
    const r = await run();
    assert.equal(r.status, "failed");
    assert.deepEqual((await registered()).map((x) => [x.email, x.state]), [["ada@open.example.com", "pending"]]);
    assert.deepEqual(held(), ["ada@open.example.com"], "the provider holds her: the call did land");
  });

  it("reconciles that run on the next one: confirmed, not enrolled a second time", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "after";
    await run();
    const calls = world.enrolCalls;
    const next = await run();
    assert.equal(next.status, "succeeded", next.stoppedBy);
    assert.equal(world.enrolCalls, calls, "a reconciled enrolment was made again");
    assert.deepEqual(next.reconciled.map((e) => emailOf(e.person)), ["ada@open.example.com"]);
    assert.equal(next.enrolled.length, 0);
    assert.deepEqual((await registered()).map((x) => [x.email, x.state, x.run_id === next.runId]), [["ada@open.example.com", "enrolled", true]]);
  });

  it("does not confirm a pending row on a lead found by its address under no key of its own: it replays the key (0060)", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "before";
    await run();
    const [pending] = await registered();
    assert.equal(pending?.state, "pending");
    // Meanwhile someone else put Ada in the same sequence, bare.
    world.foreign.set("ada@open.example.com", undefined);
    const next = await run();
    assert.deepEqual(next.reconciled, [], "a lead the kernel did not make was taken as its own");
    assert.deepEqual(world.keysSent.slice(-1), [pending!.idempotency_key], "the key on record was not replayed");
    assert.deepEqual((await registered()).map((x) => x.state), ["refused"], "the provider's conflict was not recorded");
    assert.ok(next.skipped.some((s) => s.reason === "duplicate" && /enrolled outside this engine/.test(s.detail)));
  });

  it("makes the enrolment on the next run when the provider never got it, with the key on record", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "before";
    await run();
    const [pending] = await registered();
    assert.equal(pending?.state, "pending");
    const next = await run();
    assert.deepEqual(next.enrolled.map((e) => emailOf(e.person)), ["ada@open.example.com"]);
    assert.deepEqual(world.keysSent, [pending!.idempotency_key, pending!.idempotency_key], "the retry used another key");
    assert.equal((await registered())[0]?.state, "enrolled");
  });

  it("keeps the key on record even when the person's keys have grown since", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "before";
    await run();
    const [pending] = await registered();
    // The same person, now recorded with a second key: the computed key changes, the recorded one does not.
    await client.query("update relations.person set external_id = 'net_a:ada' where email = 'ada@open.example.com'");
    await run();
    assert.equal(world.keysSent.length, 2);
    assert.equal(world.keysSent[1], pending!.idempotency_key);
  });

  it("records a refusal as refused, and skips the person as unreachable", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "refuse";
    const r = await run();
    assert.deepEqual(r.skipped.filter((s) => s.person).map((s) => [s.reason, s.detail]), [["unreachable", "this address cannot be sequenced"]]);
    const [x] = await registered();
    assert.deepEqual([x?.state, x?.refusal], ["refused", "invalid: this address cannot be sequenced"]);
  });

  it("puts a refused row back to pending before asking the provider again: a run that dies then leaves it pending", async () => {
    world.listed[0]!.people = [{ email: "ada@open.example.com", name: "Ada" }];
    world.crash = "refuse";
    await run();
    assert.deepEqual((await registered()).map((x) => x.state), ["refused"]);
    world.crash = "after";
    const r = await run();
    assert.equal(r.status, "failed");
    assert.deepEqual(held(), ["ada@open.example.com"], "the provider holds her: the call did land");
    assert.deepEqual((await registered()).map((x) => [x.state, x.refusal]), [["pending", null]], "the row still reads as the provider's refusal");
  });

  it("keeps every skip with its reason, the four never folded into one", async () => {
    world.enrolled.set("seeded", "bo@open.example.com");
    world.listed[0]!.people = [
      { email: "bo@open.example.com", name: "Bo" },
      { email: "ada@open.example.com", name: "Ada" },
      { email: "fay@open.example.com", name: "Fay" },
      { email: "dee@customer.example.org", name: "Dee" },
    ];
    world.listedCompanies = ["nobody.example.com"];
    world.remaining = 1;
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    const kept = await skips(r.runId);
    const byReason = (reason: string) => kept.filter((k) => k.reason === reason).map((k) => k.detail).sort();
    assert.deepEqual(byReason("protected"), ["an address is on a protected domain", "the account is protected"]);
    assert.deepEqual(byReason("duplicate"), ["already in the sequence (active)"]);
    assert.deepEqual(byReason("capacity"), ["no capacity left on the given senders"]);
    assert.deepEqual(byReason("unreachable"), ["a company on a list names nobody to write to"]);
    assert.equal(kept.length, r.skipped.length, "a reported skip was not kept, or the other way round");
  });

});

/* -------------------------------------------------------------------------- */
/* A domain is compared as the host it names (decision 0028)                   */
/* -------------------------------------------------------------------------- */

describe("domains spelled as URLs", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("protects a company whose domain is a URL when the protected set writes it bare", async () => {
    world.listed = [{ domain: "http://WWW.Customer.Example.org/about", people: [{ email: "cy@cy-consulting.example.net", name: "Cy" }] }];
    const r = await run();
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ["protected"]);
  });

  it("protects a person on a protected domain the protected set writes as a URL", async () => {
    world.protected = [{ domain: "https://customer.example.org/", reason: "customer" }];
    world.listed = [{ domain: "open.example.com", people: [{ email: "dee@Customer.Example.org", name: "Dee" }, { email: "ada@open.example.com", name: "Ada" }] }];
    await run();
    assert.deepEqual(held(), ["ada@open.example.com"]);
  });

  it("stops on a protected account whose domain names no host: it would match nothing", async () => {
    world.protected = [{ domain: "http://", reason: "customer" }];
    const r = await run();
    assert.equal(r.status, "failed");
    // Not blank, and not a host: refused as such since 0044, no longer read as "no key".
    assert.match(r.stoppedBy ?? "", /a protected row's domain is not a host: "http:\/\/"/);
    assert.equal(world.enrolCalls, 0);
  });

  it("excludes a company whose domain names no host, as an unreadable key (0044)", async () => {
    world.listed = [{ domain: "http://", people: [{ email: "eve@elsewhere.example.net", name: "Eve" }] }];
    const r = await run();
    assert.deepEqual(r.skipped.map((s) => [s.reason, s.detail]), [["unreadable_key", 'its domain is not a host that can be read: "http://"']]);
  });
});

/* -------------------------------------------------------------------------- */
/* The opt-out, read by every path that contacts anyone                        */
/* -------------------------------------------------------------------------- */

/** The register refuses a truncate that would destroy an entry (0052); between tests, its triggers are set aside, as only a database's owner can. */
const forgetRegister = () => client.query("set session_replication_role = replica; truncate relations.suppression; set session_replication_role = origin");

describe("the opt-out", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  // P1 and P1c (0013: an identity is a set of keys). Bo is recorded by an
  // address and a profile id, the address first, and objected under one of
  // them after his draft was approved. Only the key differs between the two
  // probes: P1c, under the first, is what shows that P1 can fail for the
  // order alone.
  const objectedUnder = async (key: { kind: string; value: string; network?: string }) => {
    world.listed = [{ domain: "open.example.com", people: [{ email: "bo@open.example.com", name: "Bo", externalId: "net_a:77" }] }];
    await seed();
    await client.query("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T1}', now())", [fingerprintOf(SECRET, key, identity)]);
  };

  it("P1 — skips a person who objected under a key that is not the identity's first", async () => {
    await objectedUnder({ kind: "social_profile_id", network: "net_a", value: "77" });
    try {
      const r = await run();
      assert.deepEqual(held(), [], "a person who objected was enrolled");
      assert.deepEqual(r.skipped.map((s) => s.reason), ["opted_out"]);
    } finally {
      await forgetRegister();
    }
  });

  it("P1c — skips them under the first key, the order P1 only changes", async () => {
    await objectedUnder({ kind: "email", value: "bo@open.example.com" });
    try {
      const r = await run();
      assert.deepEqual(held(), []);
      assert.deepEqual(r.skipped.map((s) => s.reason), ["opted_out"]);
    } finally {
      await forgetRegister();
    }
  });

  // Ada is at an open company, unprotected, never enrolled: only her opt-out,
  // recorded after her draft was approved, can stop her.
  it("skips a person who opted out, and the sequencer never holds them", async () => {
    await seed();
    await client.query("update relations.person set opted_out_at = now() where email = 'ada@open.example.com'");
    const r = await run();
    assert.deepEqual(held(), ["bo@open.example.com"]);
    assert.deepEqual(r.skipped.filter((s) => s.reason === "opted_out").map((s) => emailOf(s.person!)), ["ada@open.example.com"]);
    const kept = (await client.query("select reason from acquisition.enrolment_skip where run_id = $1 and reason = 'opted_out'", [r.runId])).rows;
    assert.equal(kept.length, 1, "the opt-out skip was not kept with the run");
  });

  // Ada objected, after her draft was approved, and the register holds her
  // address (0052): the one reader finds her (0055), whatever her row says.
  it("skips a person the register holds an objection for", async () => {
    await seed();
    await client.query("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T1}', now())", [fingerprintOf(SECRET, { kind: "email", value: "ada@open.example.com" }, identity)]);
    try {
      const r = await run();
      assert.deepEqual(held(), ["bo@open.example.com"], "an erased objector was enrolled");
      assert.deepEqual(r.skipped.filter((s) => s.reason === "opted_out").map((s) => [emailOf(s.person!), s.detail]), [["ada@open.example.com", "objected before an erasure; the register holds it"]]);
    } finally {
      await forgetRegister();
    }
  });

  it("stops the run, enrolling nobody, while the register cannot be read: a version's secret is missing (0063)", async () => {
    const r = await run({}, { fingerprints: fingerprinter("T1", { T1: SECRET }, ["T0"], identity) });
    assert.match(r.stoppedBy ?? "", /the objection cannot be read: the register cannot be read: no secret is held for version T0/);
    assert.deepEqual(held(), []);
  });
});

/* -------------------------------------------------------------------------- */
/* Protection by the company id, and never as an identity (0033)               */
/* -------------------------------------------------------------------------- */

describe("protection by company id", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const id = (value: string) => ({ subject: "company", keys: [{ kind: "social_company_id", network: "net_a", value }] });

  // The candidate's domain is open: only its company id is protected.
  it("skips a company protected by its company id alone, and the sequencer never holds its people", async () => {
    world.listed = [{ domain: "open.example.com", externalId: "net_a:4242", people: [{ email: "ada@open.example.com", name: "Ada" }] }];
    world.protected = [{ domain: "client.example.net", identity: { subject: "company", keys: [{ kind: "domain", value: "client.example.net" }, ...id("4242").keys] }, reason: "customer" }];
    const r = await run();
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => [s.reason, s.company.domain]), [["protected", "open.example.com"]]);
  });

  it("passes two runs in a row whose protected set names another company id for the same domain, writing nothing from it", async () => {
    world.protected = [{ domain: "customer.example.org", identity: { subject: "company", keys: [{ kind: "domain", value: "customer.example.org" }, ...id("1001").keys] }, reason: "customer" }];
    const counted = async () => (await client.query("select (select count(*) from relations.company)::int as companies, (select count(*) from relations.person)::int as people")).rows[0];
    await seed();
    const before = await counted();
    const first = await run({ dryRun: true });
    world.protected = [{ domain: "customer.example.org", identity: { subject: "company", keys: [{ kind: "domain", value: "customer.example.org" }, ...id("2002").keys] }, reason: "customer" }];
    const second = await run({ dryRun: true });
    assert.deepEqual([first.status, second.status], ["succeeded", "succeeded"], `${first.stoppedBy} / ${second.stoppedBy}`);
    assert.deepEqual(second.skipped.map((s) => [s.reason, s.company.domain]), [["protected", "customer.example.org"]]);
    assert.deepEqual(await counted(), before, "reading the protected set wrote to relations");
  });

  it("reports distinct accounts, not rows", async () => {
    world.protected = [
      { domain: "customer.example.org", identity: id("1"), reason: "customer" },
      { domain: "customer.example.org", identity: id("2"), reason: "customer" },
      { domain: "other.example.net", reason: "customer" },
    ];
    const r = await run({ dryRun: true });
    assert.deepEqual([r.protectedAccounts, r.protectedRows], [2, 3]);
  });
});

/* -------------------------------------------------------------------------- */
/* An uncovered customer, and its acknowledgement (0034)                        */
/* -------------------------------------------------------------------------- */

describe("an uncovered customer", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(() => {
    world.protected = [
      { domain: "customer.example.org", customerId: "cust-a", reason: "customer" },
      // No key on any of cust-z's rows: nothing can protect it.
      { name: "Zed", customerId: "cust-z", reason: "customer" },
    ];
  });

  it("stops the run, naming itself, until a person acknowledges it — and stops it again once withdrawn", async () => {
    const before = await run({ dryRun: true });
    assert.equal(before.status, "failed");
    assert.match(before.stoppedBy ?? "", /no key on any row.*cust-z \(Zed\)/);

    await acknowledgeUncovered(db, { customerId: "cust-z", note: "no key upstream; reviewed", by: "an operator" });
    const acknowledged = await run({ dryRun: true });
    assert.equal(acknowledged.status, "succeeded", acknowledged.stoppedBy);
    assert.deepEqual(acknowledged.protection?.uncovered, [{ customerId: "cust-z", name: "Zed", rows: 1 }]);
    assert.deepEqual([acknowledged.protectedAccounts, acknowledged.protectedRows], [2, 2]);

    await withdrawAcknowledgement(db, { customerId: "cust-z", by: "an operator" });
    const withdrawn = await run({ dryRun: true });
    assert.equal(withdrawn.status, "failed");
  });
});

/* -------------------------------------------------------------------------- */
/* What the sequencer declares, and the state it leads to (decision 0051)      */
/* -------------------------------------------------------------------------- */

describe("a sequencer that cannot suspend (0051)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const runs = async () => (await client.query("select count(*)::int as n from core.run where process_key like 'acquisition.enrol.%'")).rows[0].n as number;

  /** Refused before anything: no run, no protection read, no provider call, nobody held. */
  async function refusedOutright(pattern: RegExp, dryRun = false) {
    const before = await runs();
    await assert.rejects(run({ dryRun }), (e: Error) => e instanceof CannotSuspend && pattern.test(e.message));
    assert.equal(await runs(), before, "a run was opened for an enrolment that could not happen");
    assert.deepEqual([world.enrolCalls, world.statusCalls, held().length], [0, 0, 0]);
  }

  it("is refused when it declares nothing — nothing said is not \"can suspend\"", async () => {
    declared = undefined;
    await refusedOutright(/declares nothing about what it can do/);
  });

  it("is refused in a dry run too: the dry run shows what the live one would do", async () => {
    declared = undefined;
    await refusedOutright(/declares nothing/, true);
  });

  it("is refused when it declares that it cannot suspend, and the refusal carries its reason", async () => {
    declared = { ...canSuspend(), suspend: { serves: "no", why: "the provider has no way to stop one person" } };
    await refusedOutright(/cannot suspend one person in a sequence \(the provider has no way to stop one person\)/);
  });

  it("is refused when its declaration cannot be read: a measured gap without its date", async () => {
    const s = canSuspend().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    declared = { ...canSuspend(), suspend: { ...s, gap: { known: true, minutes: 5, basis: "a live test" } as never } };
    await refusedOutright(/suspend\.gap\.measuredOn/);
  });

  it("is refused when it names a cost outside 0051's vocabulary: the registry's jsonb would take anything", async () => {
    const s = canSuspend().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    declared = { ...canSuspend(), suspend: { ...s, costs: { person: ["mildly_annoying" as never], sequence: [] } } };
    await refusedOutright(/suspend\.costs\.person: "mildly_annoying" is not in 0051's vocabulary/);
  });

  it("enrols through one that can suspend, with its gap still unknown", async () => {
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
  });
});

// PROVISIONAL, as the guard it tests: removed with it when 0055's lands.
describe("once an erasure has run, without 0052's register", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const runs = async () => (await client.query("select count(*)::int as n from core.run where process_key like 'acquisition.enrol.%'")).rows[0].n as number;
  /** A live erasure run on record, as `kernel-erase` leaves one; removed after, so no other test sees it. */
  async function withAnErasure(body: () => Promise<void>) {
    const [{ id }] = (await client.query("insert into core.run (process_key, trigger, actor_type, actor_id, dry_run) values ('relations.person.erase', 'cli', 'human', 'an operator', false) returning id")).rows;
    try {
      await body();
    } finally {
      await client.query("delete from core.run where id = $1", [id]);
    }
  }

  it("refuses a live enrolment from any caller, before a run is opened or a provider called", async () => {
    await withAnErasure(async () => {
      const before = await runs();
      await assert.rejects(run(), (e: Error) => e instanceof ErasedWithoutRegister && /an erasure has run on this instance/.test(e.message));
      assert.equal(await runs(), before, "a run was opened for an enrolment that could not happen");
      assert.deepEqual([world.enrolCalls, held().length], [0, 0]);
    });
  });

  it("still lets a dry run read, and a dry erasure opens no window", async () => {
    await withAnErasure(async () => {
      const r = await run({ dryRun: true });
      assert.equal(r.status, "succeeded", r.stoppedBy);
    });
    await client.query("insert into core.run (process_key, trigger, actor_type, actor_id, dry_run) values ('relations.person.erase', 'cli', 'human', 'an operator', true)");
    try {
      assert.equal((await run()).status, "succeeded");
    } finally {
      await client.query("delete from core.run where process_key = 'relations.person.erase'");
    }
  });
});

describe("the memory sequencer, held to its declaration (0054)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const ctx = (dryRun: boolean) => ({ runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" as const }, dryRun });

  it("suspends the person it declares it parks: they are no longer held", async () => {
    await run();
    const key = world.keysSent[world.keysSent.length - 1]!;
    const who = world.enrolled.get(key)!;
    const person: Identity = { subject: "person", keys: [{ kind: "email", value: who }] };
    const asked = { idempotencyKey: key, person, sequenceKey: "welcome", reason: "a test" };
    assert.deepEqual(await sequencer.withdraw(asked, ctx(true)), { ok: true, simulated: true, value: { found: true, asOf: NOW.toISOString() } });
    assert.ok(held().includes(who), "a dry run let go of the person");
    const r = await sequencer.withdraw(asked, ctx(false));
    assert.ok(r.ok && r.value.found && r.value.readBack, JSON.stringify(r));
    assert.ok(!held().includes(who), "the double declares it parks the person, and still holds them");
    const again = await sequencer.withdraw(asked, ctx(false));
    assert.ok(again.ok && again.value.found === false, JSON.stringify(again));
  });
});

describe("the suspended state (0051)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  /** A person enrolled in `welcome`, as the registry holds one: the list's, once it is seeded. */
  async function enrolledRow(email: string, state = "enrolled"): Promise<string> {
    const person = await recorded("person", { column: "email", value: email }, { email });
    return (
      await client.query(
        "insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'k-' || $2, $3, 'memory-sequencer', 'system') returning id",
        [person, email, state],
      )
    ).rows[0].id as string;
  }
  const aRun = async () =>
    (await client.query("insert into core.run (process_key, trigger, status, actor_type, dry_run) values ('acquisition.suspend.test', 'cli', 'running', 'system', false) returning id")).rows[0].id as string;
  const suspend = async (id: string, runId: string) =>
    client.query(
      `update acquisition.enrolment set state = 'suspended', suspension_asked_at = now(), suspension_run_id = $2,
         suspension_read_back = '{"state":"active","asOf":"2026-10-20T07:34:23Z"}', suspension_method = 'parking the person in a far-off step',
         suspension_costs = '{"person":["provider_status_stays_active"],"sequence":["shared_state_changes"]}'
       where id = $1`,
      [id, runId],
    );

  it("is reached from enrolled, carrying when it was asked, by which run, what was read back and the method's costs", async () => {
    const id = await enrolledRow("ada@open.example.com");
    const runId = await aRun();
    await suspend(id, runId);
    const [row] = (await client.query("select state, suspension_run_id, suspension_method, suspension_costs, suspension_read_back from acquisition.enrolment where id = $1", [id])).rows;
    assert.deepEqual(
      [row.state, row.suspension_run_id, row.suspension_method, row.suspension_costs.sequence, row.suspension_read_back.state],
      ["suspended", runId, "parking the person in a far-off step", ["shared_state_changes"], "active"],
    );
  });

  it("is refused without its record, and a record is refused on a row that is not suspended", async () => {
    const id = await enrolledRow("ada@open.example.com");
    await assert.rejects(client.query("update acquisition.enrolment set state = 'suspended' where id = $1", [id]), /enrolment_suspension_recorded/);
    await assert.rejects(client.query("update acquisition.enrolment set suspension_method = 'x' where id = $1", [id]), /enrolment_suspension_recorded/);
  });

  it("is reached from enrolled, or from pending under an attestation only: never created suspended, never from refused (0060)", async () => {
    const runId = await aRun();
    // A read-back on a pending row: the provider confirmed it, so it goes through enrolled.
    const pending = await enrolledRow("pending@open.example.com", "pending");
    await assert.rejects(suspend(pending, runId), /a pending enrolment is suspended as it stands only under a person's attestation/);
    const refused = await enrolledRow("refused@open.example.com", "refused");
    await assert.rejects(suspend(refused, runId), /refused to suspended is not a move an enrolment makes/);
    // A person's word, on the same pending row: as it stands.
    await client.query(`update acquisition.enrolment set state = 'suspended', suspension_asked_at = now(), suspension_run_id = $2, suspension_attestation = '{"case": "unbound", "kind": "stopped_by_hand", "how": "by hand"}' where id = $1`, [pending, runId]);
    assert.equal((await client.query("select state from acquisition.enrolment where id = $1", [pending])).rows[0].state, "suspended");
    const person = (await client.query("insert into relations.person (email) values ('new@open.example.com') returning id")).rows[0].id;
    await assert.rejects(
      client.query(
        `insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type, suspension_asked_at, suspension_read_back, suspension_method, suspension_costs)
         values ($1, 'welcome', 'email', 'k', 'suspended', 'memory-sequencer', 'system', now(), '{}', 'm', '{"person":[],"sequence":[]}')`,
        [person],
      ),
      /cannot be created suspended/,
    );
  });

  it("is terminal: it does not become enrolled again, and its record does not change", async () => {
    const id = await enrolledRow("ada@open.example.com");
    await suspend(id, await aRun());
    await assert.rejects(client.query("update acquisition.enrolment set state = 'enrolled', suspension_asked_at = null, suspension_read_back = null, suspension_method = null, suspension_costs = null where id = $1", [id]), /terminal/);
    await assert.rejects(client.query("update acquisition.enrolment set suspension_method = 'something else' where id = $1", [id]), /terminal/);
    // Attribution, not the record: losing the run keeps the suspension.
    await client.query("update acquisition.enrolment set suspension_run_id = null where id = $1", [id]);
  });

  it("is never enrolled again by a run, and the provider is not even asked", async () => {
    await seed();
    const id = await enrolledRow("ada@open.example.com");
    await suspend(id, await aRun());
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(held(), ["bo@open.example.com"]);
    const skip = r.skipped.find((s) => s.person && emailOf(s.person) === "ada@open.example.com");
    assert.equal(skip?.reason, "suspended");
    assert.match(skip?.detail ?? "", /suspended from this sequence/);
    const kept = (await client.query("select reason from acquisition.enrolment_skip where run_id = $1 and reason = 'suspended'", [r.runId])).rows;
    assert.equal(kept.length, 1, "the suspended skip was not kept under its own reason");
    assert.equal(world.statusCalls, 1, "the provider was asked about the suspended person");
  });
});

/* -------------------------------------------------------------------------- */

describe("the run's start stops what already runs at a newly protected account (0057)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const states = async () => (await client.query("select state, suspension_run_id from acquisition.enrolment order by id")).rows as { state: string; suspension_run_id: string | null }[];

  it("suspends the enrolments at an account that became protected, under this run, before enrolling anyone", async () => {
    const first = await run();
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
    world.protected.push({ domain: "open.example.com", reason: "customer" });
    const second = await run();
    assert.equal(second.status, "succeeded", second.stoppedBy);
    assert.deepEqual(held(), [], "the provider still sends to people at a protected account");
    assert.deepEqual((await states()).map((s) => [s.state, s.suspension_run_id]), [["suspended", second.runId], ["suspended", second.runId]]);
    assert.equal(second.protectedStop?.stops.length, 2);
    assert.equal(second.enrolled.length, 0);
    const recorded = (await client.query("select run_id from acquisition.protection_held where run_id = any($1)", [[first.runId, second.runId]])).rows.map((r) => r.run_id);
    assert.deepEqual(recorded.sort(), [first.runId, second.runId].sort(), "each run that held the promise records it, the one that stopped nobody too");
  });

  it("enrols nobody while an enrolment at a protected account cannot be stopped", async () => {
    // At the protected account, on a channel no sequencer here takes: the act
    // is refused, and nothing else about this run would stop it.
    await seed();
    const { id: companyId } = await one("select id from relations.company where domain = 'customer.example.org'");
    const { id: personId } = await one("select id from relations.person where email = 'cy@cy-consulting.example.net'");
    await client.query(
      "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'welcome', 'social_message', 'key-cy', 'enrolled', 'memory-sequencer', 'system')",
      [personId, companyId],
    );
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /could not all be stopped, so nobody new is enrolled.*no sequencer is bound to the channel "social_message"/);
    assert.equal(world.enrolCalls, 0, "an enrolment was attempted");
    assert.deepEqual(held(), []);
    assert.equal((await row(r.runId)).status, "failed");
    assert.equal((await client.query("select 1 from acquisition.protection_held where run_id = $1", [r.runId])).rows.length, 0);
  });

  it("does not count what it judges among the companies the run excluded (0044)", async () => {
    await run();
    // open.example.com becomes protected and is on no list this run reads:
    // the run excluded nobody by it, whatever its start stopped.
    world.protected.push({ domain: "open.example.com", reason: "customer" });
    world.listed = [{ domain: "elsewhere.example.com", people: [{ email: "gus@elsewhere.example.com", name: "Gus" }] }];
    const r = await run({}, { list: "elsewhere" });
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.equal(r.protectedStop?.stops.length, 2);
    assert.deepEqual(r.protectionHits, []);
  });
});
