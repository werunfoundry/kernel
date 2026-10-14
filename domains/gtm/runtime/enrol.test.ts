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
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import type { Enrichment } from "@werunfoundry/relations/contracts/enrichment";

import type { Sequencer } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";
import type { EnrolRequest } from "./enrol.js";
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
  const migrations = join(import.meta.dirname, "../../../core/db/migrations");
  for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
    await client.query(readFileSync(join(migrations, f), "utf8"));
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
  remaining: 100,
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

const enrichment: Enrichment = {
  provider: "memory-enrichment",
  async peopleAt({ company }) {
    const domain = company.keys.find((k) => k.kind === "domain")?.value ?? "";
    const people = world.people.get(domain) ?? [];
    return ok({
      asOf: minutesAgo(60),
      items: people.map((p) => ({ identity: { subject: "person", keys: [{ kind: "email", value: p.email }] }, display: { fullName: p.name } })),
    });
  },
  async complete() {
    return ok({ found: false as const, asOf: minutesAgo(60) });
  },
};

const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value ?? "";

const sequencer: Sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  async enrol(e, ctx) {
    world.enrolCalls++;
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
    const held = [...world.enrolled.values()].includes(emailOf(person));
    return ok({ state: held ? "active" : "unknown", asOf: NOW.toISOString() });
  },
  async capacity({ sender, channel }) {
    return world.failing.has("capacity")
      ? down("capacity")
      : ok({ sender, channel, unit: "messages", window: "day" as const, remaining: world.remaining, asOf: NOW.toISOString() });
  },
};

const registry: Registry = {
  get: (c) => ({ target_list: targetList, enrichment } as Record<string, Contract>)[c],
  require: () => {
    throw new Error("not used");
  },
  forChannel: <T extends Contract>(c: string, ch: string) => (c === "sequencer" && ch === "email" ? (sequencer as unknown as T) : undefined),
  all: <T extends Contract>(c: string) => (c === "sequencer" ? [sequencer as unknown as T] : []),
  list: () => [],
};

const identity = identityVocabulary([
  {
    name: "relations",
    version: "0.0.0",
    description: "x",
    schema: "relations",
    dependsOn: [],
    identityKeys: [
      { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
      { kind: "domain", subject: "company", immutable: false, caseInsensitive: true },
    ],
  },
]);

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

beforeEach(() => {
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
      blocked(() => world.protected.push({ name: "Somebody", reason: "do_not_contact" }), /neither a domain nor an identifier/));
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

  it("stops before enrolling when capacity cannot be read", async () => {
    world.failing.add("capacity");
    const r = await run({ senders: [{ externalId: "sender@example.com" }] });
    assert.equal(r.status, "failed");
    assert.equal(world.enrolCalls, 0);
  });
});
