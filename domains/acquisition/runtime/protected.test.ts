/**
 * Tests for the act that stops what already runs at an account that became
 * protected (decision 0057, completed by 0060), against a real database: the
 * registry's rows, the suspension's record and `protection_held` are read
 * back, never taken from the report.
 *
 * The sequencer is in memory and finds a lead by address, as a provider does;
 * each test asserts on what it holds after the act. `bin/stop-protected.test.ts`
 * runs the command through an instance's own bindings.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";

import type { Sequencer, SequencerDeclaration } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetList } from "../contracts/target-list.js";
import { ageAt, stopProtectedRun } from "./protected.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_protected_${process.pid}`;
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

/* -------------------------------------------------------------------------- */

const NOW = new Date("2026-06-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const world = {
  protected: [] as ProtectedAccount[],
  protectedAsOf: minutesAgo(5),
  /** What the provider holds in the sequence, found by address: email → the key its record carries, if any, and whether it is parked. */
  leads: new Map<string, { key?: string; parked: boolean }>(),
  /** Addresses whose withdrawal the provider fails. */
  failingWithdraw: new Set<string>(),
  failingSuppress: false,
  /** The keys each live suppression listed, in order. */
  suppressed: [] as string[][],
  withdrawCalls: 0,
  suppressCalls: 0,
};

const ok = <T>(value: T): CallResult<T> => ({ ok: true, value });
const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value ?? "";

const targetList: TargetList = {
  provider: "memory-targets",
  async freshness(route) {
    return ok({ route, asOf: world.protectedAsOf });
  },
  async candidates() {
    return ok({ items: [] });
  },
  async protectedAccounts() {
    return ok({ items: world.protected });
  },
};

const declares: SequencerDeclaration = {
  enrol: { serves: "yes" },
  pullTouches: { serves: "no", why: "not in this test" },
  suspend: {
    serves: "yes",
    method: "parking the person in a far-off step",
    costs: { person: ["provider_status_stays_active"], sequence: ["shared_state_changes"] },
    gap: { known: false, why: "never measured" },
  },
  pullUnsubscribes: { serves: "no", why: "not in this test" },
};

const sequencer: Sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  declares,
  async enrol() {
    throw new Error("the act never enrols");
  },
  // By address, as a provider finds a lead, saying the key its record carries (0060).
  async withdraw({ person }, ctx) {
    world.withdrawCalls++;
    const email = emailOf(person);
    if (world.failingWithdraw.has(email)) return { ok: false, error: { code: "unavailable", message: "the sequencer is down", retryable: true } };
    const lead = world.leads.get(email);
    if (!lead) return ok({ found: false, asOf: NOW.toISOString() });
    const key = lead.key ? { idempotencyKey: lead.key } : {};
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, ...key, asOf: NOW.toISOString() } };
    lead.parked = true;
    return ok({ found: true, readBack: { parked: true }, ...key, asOf: NOW.toISOString() });
  },
  async suppress({ target }, ctx) {
    world.suppressCalls++;
    if (world.failingSuppress) return { ok: false, error: { code: "unavailable", message: "the blocklist is down", retryable: true } };
    const applied = target.keys.filter((k) => k.kind === "email" || k.kind === "domain");
    const notApplicable = target.keys.filter((k) => !applied.includes(k));
    if (applied.length === 0) return { ok: false, error: { code: "invalid", message: "no key this provider can act on", retryable: false } };
    if (!ctx.dryRun) world.suppressed.push(applied.map((k) => k.value).sort());
    return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { applied, notApplicable, asOf: NOW.toISOString() } };
  },
  async status() {
    throw new Error("the act never reads a status");
  },
  async capacity() {
    throw new Error("the act never reads capacity");
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

const act = (dryRun = false) =>
  stopProtectedRun({ db, registry, now: () => NOW }, { protectedMaxAgeMinutes: 60, dryRun, trigger: "cli", actor: { type: "system", id: "test" } });

/* The registry, written as runs leave it. */

const companyAt = async (domain: string) => (await client.query("insert into relations.company (name, domain) values ($1, $1) returning id", [domain])).rows[0].id as string;
const personAt = async (email: string, companyId?: string) =>
  (await client.query("insert into relations.person (email, company_id) values ($1, $2) returning id", [email, companyId ?? null])).rows[0].id as string;
/** An enrolment in `welcome` on email, under `key`, through the memory sequencer. */
const enrolled = async (email: string, domain: string | undefined, state: "enrolled" | "pending", key: string, channel = "email") => {
  const companyId = domain ? await companyAt(domain) : undefined;
  const personId = await personAt(email, companyId);
  return (
    await client.query(
      "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'welcome', $3, $4, $5, 'memory-sequencer', 'system') returning id",
      [personId, companyId ?? null, channel, key, state],
    )
  ).rows[0].id as string;
};
const row = async (id: string) =>
  (await client.query("select state, suspension_run_id, suspension_read_back, suspension_attestation from acquisition.enrolment where id = $1", [id])).rows[0] as {
    state: string;
    suspension_run_id: string | null;
    suspension_read_back: unknown;
    suspension_attestation: unknown;
  };
const held = async () => (await client.query("select run_id, protected_as_of, accounts from acquisition.protection_held order by protected_as_of")).rows as { run_id: string; protected_as_of: Date; accounts: number }[];
const runRow = async (id: string) => (await client.query("select status, error from core.run where id = $1", [id])).rows[0] as { status: string; error: string | null };

beforeEach(async () => {
  if (client) await client.query("truncate acquisition.enrolment, acquisition.protection_held, relations.person, relations.company, core.run cascade");
  world.protected = [{ domain: "acct.example.org", reason: "customer" }];
  world.protectedAsOf = minutesAgo(5);
  world.leads = new Map();
  world.failingWithdraw = new Set();
  world.failingSuppress = false;
  world.suppressed = [];
  world.withdrawCalls = 0;
  world.suppressCalls = 0;
});

/* -------------------------------------------------------------------------- */

describe("stopping what runs at a newly protected account (0057)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("suspends an enrolment at a company that became protected, recorded under the run with the read-back the adapter returned", async () => {
    // Cy's address is on another domain: only the company's protection can stop Cy.
    const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy");
    world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.equal(world.leads.get("cy@cy-consulting.example.net")?.parked, true, "the provider still sends to Cy");
    const after = await row(id);
    assert.equal(after.state, "suspended");
    assert.equal(after.suspension_run_id, r.runId);
    assert.deepEqual(after.suspension_read_back, { parked: true });
    assert.equal((await runRow(r.runId)).status, "succeeded");
    // What the adapter answered, never a verification the kernel did not see.
    assert.match(r.act!.suppressions[0]!.outcome, /^the adapter answered that it applies acct\.example\.org, as of /);
  });

  it("leaves an enrolment at an open account running", async () => {
    const id = await enrolled("ada@open.example.com", "open.example.com", "enrolled", "key-ada");
    world.leads.set("ada@open.example.com", { key: "key-ada", parked: false });
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.equal((await row(id)).state, "enrolled");
    assert.equal(world.leads.get("ada@open.example.com")?.parked, false);
    assert.equal(world.withdrawCalls, 0);
    assert.equal(world.suppressCalls, 0);
  });

  it("stops a person whose address is on a protected domain, though the company they were enrolled through is open", async () => {
    const id = await enrolled("dee@acct.example.org", "open.example.com", "enrolled", "key-dee");
    world.leads.set("dee@acct.example.org", { key: "key-dee", parked: false });
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.equal((await row(id)).state, "suspended");
    assert.match(r.act!.stops[0]!.why, /an address is on a protected domain/);
    // The open company is not the account: only the protected domain is listed.
    assert.deepEqual(world.suppressed, [["acct.example.org"]]);
  });

  it("records the promise held as of the protected set it read, by a run that found nobody to stop", async () => {
    await enrolled("ada@open.example.com", "open.example.com", "enrolled", "key-ada");
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(r.act!.stops, []);
    const rows = await held();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.run_id, r.runId);
    assert.equal(rows[0]!.protected_as_of.toISOString(), world.protectedAsOf);
    assert.equal(rows[0]!.accounts, 1);
  });

  describe("a pending row, as 0060 has it", () => {
    it("held under its key: confirmed by the read-back, then suspended", async () => {
      const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "pending", "key-cy");
      world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
      const r = await act();
      assert.equal(r.status, "succeeded", r.stoppedBy);
      assert.equal((await row(id)).state, "suspended");
      assert.equal(world.leads.get("cy@cy-consulting.example.net")?.parked, true);
    });

    it("held under no key of the kernel's: stopped by address, left pending, and its stop not written as its suspension", async () => {
      const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "pending", "key-cy");
      world.leads.set("cy@cy-consulting.example.net", { parked: false });
      const r = await act();
      assert.equal(r.status, "succeeded", r.stoppedBy);
      assert.equal(world.leads.get("cy@cy-consulting.example.net")?.parked, true, "the person was not stopped");
      const after = await row(id);
      assert.equal(after.state, "pending");
      assert.equal(after.suspension_read_back, null);
      assert.match(r.act!.stops[0]!.outcome, /under no key of the kernel.s, and returned a read-back for a stop by address: left pending/);
    });

    it("the provider holds nothing for it: left pending, and the act holds", async () => {
      const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "pending", "key-cy");
      const r = await act();
      assert.equal(r.status, "succeeded", r.stoppedBy);
      assert.equal(world.withdrawCalls, 1, "the provider was not asked");
      assert.equal((await row(id)).state, "pending");
      assert.equal((await held()).length, 1);
    });
  });

  it("suppresses the protected domain, wider than the host it matched, and the person's address it does not cover", async () => {
    await enrolled("cy@cy-consulting.example.net", "app.acct.example.org", "enrolled", "key-cy");
    world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(world.suppressed, [["acct.example.org", "app.acct.example.org"], ["cy@cy-consulting.example.net"]]);
  });

  it("says, without failing, a person the provider can list by none of their keys", async () => {
    // Known here by a profile id alone: the provider holds no lead for them,
    // and its blocklist takes addresses and domains only — the contract's
    // `invalid`, a fact of the provider rather than a write that failed.
    const companyId = await companyAt("acct.example.org");
    const [{ id: personId }] = (await client.query("insert into relations.person (external_id, company_id) values ('net_a:cy-123', $1) returning id", [companyId])).rows;
    await client.query(
      "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'welcome', 'email', 'key-cy', 'enrolled', 'memory-sequencer', 'system')",
      [personId, companyId],
    );
    const r = await act();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(world.suppressed, [["acct.example.org"]]);
    assert.match(r.act!.suppressions.at(-1)!.outcome, /it can act on none of these keys/);
  });

  describe("it fails closed", () => {
    it("a suspension that fails fails the act, names the adapter, and records no promise held", async () => {
      const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy");
      world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
      world.failingWithdraw.add("cy@cy-consulting.example.net");
      const r = await act();
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", /memory-sequencer.*the sequencer is down.*running again is the remedy/);
      assert.equal((await row(id)).state, "enrolled");
      assert.deepEqual(await held(), []);
      assert.equal((await runRow(r.runId)).status, "failed");
    });

    it("a suppression that fails fails the act, and records no promise held", async () => {
      await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy");
      world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
      world.failingSuppress = true;
      const r = await act();
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", /suppression of .*memory-sequencer.*the blocklist is down/);
      assert.deepEqual(await held(), []);
    });

    it("an enrolment on a channel no sequencer takes fails the act", async () => {
      await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy", "social_message");
      const r = await act();
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", /no sequencer is bound to the channel "social_message"/);
      assert.deepEqual(await held(), []);
    });

    it("a stale protected set changes nothing and asks nobody", async () => {
      const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy");
      world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
      world.protectedAsOf = minutesAgo(61);
      const r = await act();
      assert.equal(r.status, "failed");
      assert.match(r.stoppedBy ?? "", /61 minutes old, older than the 60 allowed/);
      assert.equal(world.withdrawCalls + world.suppressCalls, 0);
      assert.equal((await row(id)).state, "enrolled");
      assert.deepEqual(await held(), []);
    });
  });

  it("in a dry run, says whom it would stop and writes nothing", async () => {
    const id = await enrolled("cy@cy-consulting.example.net", "acct.example.org", "enrolled", "key-cy");
    world.leads.set("cy@cy-consulting.example.net", { key: "key-cy", parked: false });
    const r = await act(true);
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.equal(r.act!.stops[0]!.outcome, "would suspend");
    assert.equal((await row(id)).state, "enrolled");
    assert.equal(world.leads.get("cy@cy-consulting.example.net")?.parked, false);
    assert.deepEqual(world.suppressed, []);
    assert.deepEqual(await held(), []);
  });
});

describe("the protected set's age, read against the run's start (0057)", () => {
  const started = new Date("2026-06-01T12:00:00Z");
  it("in whole minutes when it is a minute old or more", () => {
    assert.equal(ageAt("2026-06-01T11:55:30Z", started), "4 minutes old when its run started");
    assert.equal(ageAt("2026-06-01T11:59:00Z", started), "1 minute old when its run started");
  });
  it("under a minute, without a figure that looks like a fault", () => {
    assert.equal(ageAt("2026-06-01T11:59:59.995Z", started), "less than a minute old when its run started");
  });
  it("dated after the run started: fresher than it needed, never a negative age", () => {
    assert.equal(ageAt("2026-06-01T12:00:00.004Z", started), "computed after its run started");
  });
});
