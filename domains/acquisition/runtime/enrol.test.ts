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
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallContext, CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import type { PeopleSource } from "@werunfoundry/relations/contracts/people-source";

import type { CapacityLimit, Sequencer } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";
import type { EnrolRequest } from "./enrol.js";
import { acknowledgeUncovered, withdrawAcknowledgement } from "./acknowledge.js";
import { enrol } from "./enrol.js";

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

const world = {
  candidates: [] as TargetCompany[],
  protected: [] as ProtectedAccount[],
  people: new Map<string, { email: string; name: string }[]>(),
  protectedAsOf: minutesAgo(5),
  /** When set, the named read fails. */
  failing: new Set<string>(),
  /** Protected accounts split across pages of this size. */
  pageSize: 100,
  /** What the sequencer holds: key → email. A dry run never writes here. */
  enrolled: new Map<string, string>(),
  enrolCalls: 0,
  statusCalls: 0,
  /** Every company the people source was asked about, as it was asked. */
  lookedUp: [] as Identity[],
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
    return world.failing.has("candidates") ? down("candidates") : ok({ items: world.candidates });
  },
  async protectedAccounts(query) {
    const start = Number(query.cursor ?? 0);
    if (world.failing.has(`protected-page-${start}`)) return down("the protected set");
    const items = world.protected.slice(start, start + world.pageSize);
    const next = start + world.pageSize;
    return ok({ items, ...(next < world.protected.length ? { nextCursor: String(next) } : {}) });
  },
};

const people: PeopleSource = {
  provider: "memory-people",
  async peopleAt({ company }) {
    world.lookedUp.push(company);
    const domain = company.keys.find((k) => k.kind === "domain")?.value ?? "";
    const people = world.people.get(domain) ?? [];
    return ok({
      asOf: minutesAgo(60),
      items: people.map((p) => ({ identity: { subject: "person", keys: [{ kind: "email", value: p.email }] }, display: { fullName: p.name } })),
    });
  },
};

const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value ?? "";

const sequencer: Sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
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
    const held = world.enrolled.get(e.idempotencyKey);
    if (!held && !ctx.dryRun) world.enrolled.set(e.idempotencyKey, emailOf(e.person));
    return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { state: "active", asOf: NOW.toISOString() } };
  },
  async withdraw() {
    return ok(undefined);
  },
  async suppress() {
    return ok({ applied: [], notApplicable: [] });
  },
  async status({ person }) {
    world.statusCalls++;
    const held = [...world.enrolled.values()].includes(emailOf(person));
    return ok({ state: held ? "active" : "unknown", asOf: NOW.toISOString() });
  },
  async capacity({ sender, channel }) {
    return world.failing.has("capacity")
      ? down("capacity")
      : ok({ sender, channel, limits: world.limits(), asOf: NOW.toISOString() });
  },
};

const registry: Registry = {
  get: (c) => ({ target_list: targetList, people_source: people } as Record<string, Contract>)[c],
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

const request = (over: Partial<EnrolRequest> = {}): EnrolRequest => ({
  sequenceKey: "welcome",
  channel: "email",
  protectedMaxAgeMinutes: 60,
  dryRun: false,
  trigger: "cli",
  actor: { type: "system", id: "test" },
  ...over,
});

const run = (over: Partial<EnrolRequest> = {}) => enrol({ db, registry, identity, now: () => NOW }, request(over));

const row = async (id: string) =>
  (await client.query("select status, dry_run, error from core.run where id = $1", [id])).rows[0] as {
    status: string;
    dry_run: boolean;
    error: string | null;
  };

const held = () => [...world.enrolled.values()].sort();

beforeEach(async () => {
  if (client) {
    await client.query("truncate acquisition.enrolment_skip, acquisition.enrolment, acquisition.sourcing_result, acquisition.protection_acknowledgement, relations.person, relations.company cascade");
  }
  world.statusCalls = 0;
  world.lookedUp = [];
  world.keysSent = [];
  world.crash = undefined;
  world.candidates = [
    { domain: "open.example.com", attributes: {} },
    { domain: "customer.example.org", externalId: "acct-7", attributes: {} },
  ];
  world.protected = [{ domain: "customer.example.org", reason: "customer" }];
  world.people = new Map([
    ["open.example.com", [{ email: "ada@open.example.com", name: "Ada" }, { email: "bo@open.example.com", name: "Bo" }]],
    // Cy's address is on another domain: only the account's own protection
    // can stop Cy, which is what the first test is about.
    ["customer.example.org", [{ email: "cy@cy-consulting.example.net", name: "Cy" }]],
  ]);
  world.protectedAsOf = minutesAgo(5);
  world.failing = new Set();
  world.pageSize = 100;
  world.enrolled = new Map();
  world.enrolCalls = 0;
  world.remaining = 100;
  world.limits = () => [{ unit: "messages", window: "day", remaining: world.remaining }];
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
    world.people.set("open.example.com", [{ email: "dee@customer.example.org", name: "Dee" }, { email: "ada@open.example.com", name: "Ada" }]);
    const r = await run();
    assert.deepEqual(held(), ["ada@open.example.com"]);
    assert.ok(r.skipped.some((s) => s.reason === "protected" && s.person && emailOf(s.person) === "dee@customer.example.org"));
  });

  it("protects an account matched by the source's own identifier when its domain differs", async () => {
    world.protected = [{ externalId: "acct-7", reason: "open_opportunity" }];
    world.candidates = [{ domain: "renamed.example.org", externalId: "acct-7", attributes: {} }];
    world.people.set("renamed.example.org", [{ email: "eve@renamed.example.org", name: "Eve" }]);
    await run();
    assert.deepEqual(held(), []);
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
    world.people.set("open.example.com", [
      { email: "bo@open.example.com", name: "Bo" },
      { email: "ada@open.example.com", name: "Ada" },
      { email: "fay@open.example.com", name: "Fay" },
    ]);
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

  it("writes no registry row, no person and no company in a dry run, and still keeps its skips", async () => {
    const r = await run({ dryRun: true });
    assert.equal(r.enrolled.length, 2);
    assert.deepEqual(await registered(), []);
    assert.equal((await client.query("select count(*)::int as n from relations.person")).rows[0].n, 0);
    assert.equal((await client.query("select count(*)::int as n from relations.company")).rows[0].n, 0);
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
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
    world.crash = "after";
    const r = await run();
    assert.equal(r.status, "failed");
    assert.deepEqual((await registered()).map((x) => [x.email, x.state]), [["ada@open.example.com", "pending"]]);
    assert.deepEqual(held(), ["ada@open.example.com"], "the provider holds her: the call did land");
  });

  it("reconciles that run on the next one: confirmed, not enrolled a second time", async () => {
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
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

  it("makes the enrolment on the next run when the provider never got it, with the key on record", async () => {
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
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
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
    world.crash = "before";
    await run();
    const [pending] = await registered();
    // The same person, now known by a second key: the computed key changes, the recorded one does not.
    const withHandle = people.peopleAt;
    people.peopleAt = async (q, ctx) => {
      const r = await withHandle(q, ctx);
      if (!r.ok) return r;
      return ok({ ...r.value, items: r.value.items.map((i) => ({ ...i, identity: { ...i.identity, keys: [...i.identity.keys, { kind: "social_profile_handle", value: "ada", network: "net_a" }] } })) });
    };
    try {
      await run();
    } finally {
      people.peopleAt = withHandle;
    }
    assert.equal(world.keysSent[1], pending!.idempotency_key);
  });

  it("records a refusal as refused, and skips the person as unreachable", async () => {
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
    world.crash = "refuse";
    const r = await run();
    assert.deepEqual(r.skipped.filter((s) => s.person).map((s) => [s.reason, s.detail]), [["unreachable", "this address cannot be sequenced"]]);
    const [x] = await registered();
    assert.deepEqual([x?.state, x?.refusal], ["refused", "invalid: this address cannot be sequenced"]);
  });

  it("keeps every skip with its reason, the four never folded into one", async () => {
    world.enrolled.set("seeded", "bo@open.example.com");
    world.people.set("open.example.com", [
      { email: "bo@open.example.com", name: "Bo" },
      { email: "ada@open.example.com", name: "Ada" },
      { email: "fay@open.example.com", name: "Fay" },
      { email: "dee@customer.example.org", name: "Dee" },
    ]);
    world.candidates.push({ name: "No domain", attributes: {} });
    world.remaining = 1;
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    const kept = await skips(r.runId);
    const byReason = (reason: string) => kept.filter((k) => k.reason === reason).map((k) => k.detail).sort();
    assert.deepEqual(byReason("protected"), ["an address is on a protected domain", "the account is protected"]);
    assert.deepEqual(byReason("duplicate"), ["already in the sequence (active)"]);
    assert.deepEqual(byReason("capacity"), ["no capacity left on the given senders"]);
    assert.deepEqual(byReason("unreachable"), ["no domain to find its people by"]);
    assert.equal(kept.length, r.skipped.length, "a reported skip was not kept, or the other way round");
  });

  // A dry run, so that the registry's read is the only thing that can refuse:
  // live, `recordPerson` would refuse too, and its own tests are in relations.
  it("refuses to merge: a person whose keys name two recorded people is skipped, not enrolled — read before any write", async () => {
    await client.query(
      "insert into relations.person (email, external_id) values ('ada@open.example.com', null), (null, 'net_a:42')",
    );
    world.people.set("open.example.com", [{ email: "ada@open.example.com", name: "Ada" }]);
    const withId = people.peopleAt;
    people.peopleAt = async (q, ctx) => {
      const r = await withId(q, ctx);
      if (!r.ok) return r;
      return ok({ ...r.value, items: r.value.items.map((i) => ({ ...i, identity: { ...i.identity, keys: [...i.identity.keys, { kind: "social_profile_id", value: "42", network: "net_a" }] } })) });
    };
    try {
      const r = await run({ dryRun: true });
      assert.deepEqual(r.enrolled, []);
      assert.match(r.skipped.find((s) => s.person)?.detail ?? "", /registry cannot tell who this is: the person.s id and its other key name two recorded people/);
      assert.equal(world.enrolCalls, 0);
    } finally {
      people.peopleAt = withId;
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A domain is compared as the host it names (decision 0028)                   */
/* -------------------------------------------------------------------------- */

describe("domains spelled as URLs", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("protects a candidate whose domain is a URL when the protected set writes it bare", async () => {
    world.candidates = [{ domain: "http://WWW.Customer.Example.org/about", attributes: {} }];
    world.people.set("customer.example.org", [{ email: "cy@cy-consulting.example.net", name: "Cy" }]);
    const r = await run();
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ["protected"]);
  });

  it("protects a person on a protected domain the protected set writes as a URL", async () => {
    world.protected = [{ domain: "https://customer.example.org/", reason: "customer" }];
    world.people.set("open.example.com", [{ email: "dee@Customer.Example.org", name: "Dee" }, { email: "ada@open.example.com", name: "Ada" }]);
    await run();
    assert.deepEqual(held(), ["ada@open.example.com"]);
  });

  it("looks a URL-spelled candidate's people up by its host", async () => {
    world.candidates = [{ domain: "https://open.example.com/", attributes: {} }];
    await run();
    assert.deepEqual(held(), ["ada@open.example.com", "bo@open.example.com"]);
  });

  it("stops on a protected account whose domain names no host: it would match nothing", async () => {
    world.protected = [{ domain: "http://", reason: "customer" }];
    const r = await run();
    assert.equal(r.status, "failed");
    // Not blank, and not a host: refused as such since 0044, no longer read as "no key".
    assert.match(r.stoppedBy ?? "", /a protected row's domain is not a host: "http:\/\/"/);
    assert.equal(world.enrolCalls, 0);
  });

  it("excludes a candidate whose domain names no host, as an unreadable key (0044)", async () => {
    world.candidates = [{ domain: "http://", attributes: {} }];
    const r = await run();
    assert.deepEqual(r.skipped.map((s) => [s.reason, s.detail]), [["unreadable_key", 'its domain is not a host that can be read: "http://"']]);
  });
});

/* -------------------------------------------------------------------------- */
/* Enrichment is asked with the company's keys (decision 0029)                 */
/* -------------------------------------------------------------------------- */

describe("what the people source is asked", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const keys = () => world.lookedUp.map((c) => c.keys.map((k) => `${k.kind}${k.network ? `@${k.network}` : ""}=${k.value}`));

  it("the company's id on a network, when the target list attests one, beside its domain", async () => {
    world.candidates = [
      {
        domain: "open.example.com",
        identity: { subject: "company", keys: [{ kind: "domain", value: "open.example.com" }, { kind: "social_company_id", value: "4242", network: "net_a" }] },
        attributes: {},
      },
    ];
    await run({ dryRun: true });
    assert.deepEqual(keys(), [["domain=open.example.com", "social_company_id@net_a=4242"]]);
  });

  it("the domain alone, when that is all the target list knows", async () => {
    world.candidates = [{ domain: "open.example.com", attributes: {} }];
    await run({ dryRun: true });
    assert.deepEqual(keys(), [["domain=open.example.com"]]);
  });

  it("nothing, when the target list's keys are not valid: the company is unreachable", async () => {
    world.candidates = [
      {
        domain: "open.example.com",
        identity: { subject: "company", keys: [{ kind: "domain", value: "open.example.com" }, { kind: "social_company_id", value: "4242", network: "undeclared" }] },
        attributes: {},
      },
    ];
    const r = await run({ dryRun: true });
    assert.deepEqual(world.lookedUp, []);
    assert.match(r.skipped.find((s) => s.reason === "unreachable")?.detail ?? "", /keys for it are not valid/);
  });
});

/* -------------------------------------------------------------------------- */
/* The opt-out, read by every path that contacts anyone                        */
/* -------------------------------------------------------------------------- */

describe("the opt-out", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  // Ada is at an open company, unprotected, never enrolled: only her opt-out
  // can stop her.
  it("skips a person who opted out, and the sequencer never holds them", async () => {
    await client.query("insert into relations.person (email, opted_out_at) values ('ada@open.example.com', now())");
    const r = await run();
    assert.deepEqual(held(), ["bo@open.example.com"]);
    assert.deepEqual(r.skipped.filter((s) => s.reason === "opted_out").map((s) => emailOf(s.person!)), ["ada@open.example.com"]);
    const kept = (await client.query("select reason from acquisition.enrolment_skip where run_id = $1 and reason = 'opted_out'", [r.runId])).rows;
    assert.equal(kept.length, 1, "the opt-out skip was not kept with the run");
  });
});

/* -------------------------------------------------------------------------- */
/* Enrolling the people a sourcing run kept (0031)                             */
/* -------------------------------------------------------------------------- */

describe("enrolling from a sourcing run", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  /**
   * A sourcing run on record, as `source` writes one: the run, the person
   * recorded, and the kept row carrying the completed identity.
   */
  async function sourced(
    kept: { email: string; id: string; domain: string; outcome?: string }[],
    run: { processKey?: string; dryRun?: boolean; status?: string } = {},
  ): Promise<string> {
    const { rows } = await client.query(
      "insert into core.run (process_key, trigger, status, actor_type, dry_run, finished_at) values ($1, 'cli', $2, 'human', $3, now()) returning id",
      [run.processKey ?? "acquisition.source", run.status ?? "succeeded", run.dryRun ?? false],
    );
    const runId = rows[0].id as string;
    for (const k of kept) {
      const person = { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: k.id }, { kind: "email", value: k.email }] };
      const recorded = run.dryRun
        ? undefined
        : (await client.query("insert into relations.person (email, external_id, full_name) values ($1, $2, 'Someone') returning id", [k.email, `net_a:${k.id}`])).rows[0].id;
      await client.query(
        "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, person, company, person_id, subject) values ($1, 'person', $6, 'as the run decided', $2, $3, $4, $5)",
        [runId, person, { domain: k.domain }, recorded ?? null, `person:${k.id}`, k.outcome ?? "kept"],
      );
    }
    return runId;
  }

  it("enrols exactly the people the run kept, with the keys it attested, and sources nobody", async () => {
    // Bo is recorded, but the run excluded him: a row with a person is not a
    // kept one.
    const id = await sourced([
      { email: "ada@open.example.com", id: "101", domain: "open.example.com" },
      { email: "bo@open.example.com", id: "102", domain: "open.example.com", outcome: "known_to_crm" },
    ]);
    const r = await run({ fromSourcingRun: id });
    assert.equal(r.status, "succeeded", r.stoppedBy);
    // Bo is at the same open company, and the target list would give him: the
    // run did not keep him, so he is not considered.
    assert.deepEqual(held(), ["ada@open.example.com"]);
    assert.deepEqual(world.lookedUp, [], "the people source was asked again");
    assert.deepEqual(r.enrolled[0]?.person.keys.map((k) => k.kind).sort(), ["email", "social_profile_id"]);
  });

  it("reads protection again: a company protected since the sourcing run is skipped", async () => {
    // Cy's address is elsewhere: only the company's protection, read again
    // by this run, can stop Cy.
    const id = await sourced([{ email: "cy@cy-consulting.example.net", id: "103", domain: "customer.example.org" }]);
    const r = await run({ fromSourcingRun: id });
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ["protected"]);
  });

  it("reads the opt-out again: a person who opted out since the sourcing run is skipped", async () => {
    const id = await sourced([{ email: "ada@open.example.com", id: "101", domain: "open.example.com" }]);
    await client.query("update relations.person set opted_out_at = now() where email = 'ada@open.example.com'");
    const r = await run({ fromSourcingRun: id });
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ["opted_out"]);
  });

  it("consumed twice, enrols nobody the second time: the registry catches it (0026)", async () => {
    const id = await sourced([
      { email: "ada@open.example.com", id: "101", domain: "open.example.com" },
      { email: "bo@open.example.com", id: "102", domain: "open.example.com" },
    ]);
    const first = await run({ fromSourcingRun: id });
    assert.equal(first.enrolled.length, 2);
    const calls = world.enrolCalls;
    const second = await run({ fromSourcingRun: id });
    assert.equal(second.enrolled.length, 0);
    assert.equal(world.enrolCalls, calls, "the sequencer was asked to enrol someone again");
    assert.deepEqual(second.skipped.map((s) => s.detail), ["already enrolled in this sequence, by the registry", "already enrolled in this sequence, by the registry"]);
    const rows = (await client.query("select count(*)::int as n from acquisition.enrolment")).rows[0].n;
    assert.equal(rows, 2);
  });

  it("refuses a run it cannot enrol from, before opening one of its own", async () => {
    const runs = async () => (await client.query("select count(*)::int as n from core.run where process_key like 'acquisition.enrol.%'")).rows[0].n as number;
    const before = await runs();
    await assert.rejects(run({ fromSourcingRun: await sourced([], { dryRun: true }) }), /was a dry run: it kept nobody on record/);
    await assert.rejects(run({ fromSourcingRun: await sourced([], { status: "failed" }) }), /ended as failed; only a finished sourcing run/);
    await assert.rejects(run({ fromSourcingRun: await sourced([], { processKey: "instance.verify" }) }), /is a run of instance.verify, not a sourcing run/);
    await assert.rejects(run({ fromSourcingRun: "00000000-0000-4000-8000-000000000000" }), /no run 00000000-0000-4000-8000-000000000000 is on record/);
    assert.equal(await runs(), before, "an enrolment run was opened for a sourcing run that cannot be enrolled from");
  });
});

/* -------------------------------------------------------------------------- */
/* Protection by the company id, and never as an identity (0033)               */
/* -------------------------------------------------------------------------- */

describe("protection by company id", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const id = (value: string) => ({ subject: "company", keys: [{ kind: "social_company_id", network: "net_a", value }] });

  // The candidate's domain is open: only its company id is protected.
  it("skips a company protected by its company id alone, and the sequencer never holds its people", async () => {
    world.candidates = [{ domain: "open.example.com", identity: { subject: "company", keys: [{ kind: "domain", value: "open.example.com" }, ...id("4242").keys] }, attributes: {} }];
    world.protected = [{ domain: "client.example.net", identity: { subject: "company", keys: [{ kind: "domain", value: "client.example.net" }, ...id("4242").keys] }, reason: "customer" }];
    const r = await run();
    assert.deepEqual(held(), []);
    assert.deepEqual(r.skipped.map((s) => [s.reason, s.company.domain]), [["protected", "open.example.com"]]);
  });

  it("passes two runs in a row whose protected set names another company id for the same domain, writing nothing from it", async () => {
    world.protected = [{ domain: "customer.example.org", identity: { subject: "company", keys: [{ kind: "domain", value: "customer.example.org" }, ...id("1001").keys] }, reason: "customer" }];
    const first = await run({ dryRun: true });
    world.protected = [{ domain: "customer.example.org", identity: { subject: "company", keys: [{ kind: "domain", value: "customer.example.org" }, ...id("2002").keys] }, reason: "customer" }];
    const second = await run({ dryRun: true });
    assert.deepEqual([first.status, second.status], ["succeeded", "succeeded"], `${first.stoppedBy} / ${second.stoppedBy}`);
    assert.deepEqual(second.skipped.map((s) => [s.reason, s.company.domain]), [["protected", "customer.example.org"]]);
    const written = (await client.query("select (select count(*) from relations.company)::int as companies, (select count(*) from relations.person)::int as people")).rows[0];
    assert.deepEqual(written, { companies: 0, people: 0 }, "reading the protected set wrote to relations");
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
