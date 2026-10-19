/**
 * Tests for the sourcing path (decision 0031).
 *
 * The adapters are in memory, and that is a seam (CLAUDE.md §5). What this
 * file pins is the order of the passes and what each one spares or spends,
 * against a real database: every run is recorded, every outcome is written,
 * and the tests read both.
 *
 * Every exclusion test asserts on what was *paid for* and what was
 * *recorded*, not only on the report. A report can say "excluded" while the
 * completion was bought, or the person written anyway.
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
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import type { Crm } from "@werunfoundry/relations/contracts/crm";
import type { Completion, Enrichment } from "@werunfoundry/relations/contracts/enrichment";
import type { PeopleSource } from "@werunfoundry/relations/contracts/people-source";

import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";
import type { SourceRequest } from "./source.js";
import { addressesElsewhere, companiesWanted, source } from "./source.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_source_${process.pid}`;
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
const ok = <T>(value: T): CallResult<T> => ({ ok: true, value });
const down = (what: string): CallResult<never> => ({ ok: false, error: { code: "unavailable", message: `${what} is down`, retryable: true } });

interface Someone {
  id: string;
  handle: string;
  name: string;
  /** What completion finds for them; absent finds nothing. */
  email?: string;
  /** An address the people source itself returns, before completion. */
  known?: string;
}

const world = {
  candidates: [] as TargetCompany[],
  protected: [] as ProtectedAccount[],
  /** By company domain: the people the people source returns, with no address. */
  people: new Map<string, Someone[]>(),
  /** Domains and addresses the CRM knows. */
  crmCompanies: new Set<string>(),
  crmPeople: new Set<string>(),
  /** When set, the named read fails. */
  failing: new Set<string>(),
  /** How the next completion fails, if it does. */
  completionError: undefined as undefined | "unavailable" | "invalid",
  searched: [] as string[],
  completed: [] as string[],
  crmCalls: 0,
  /** When set, the CRM answers for many domains at once, and records each batch asked. */
  crmBatched: false,
  crmBatches: [] as string[][],
  /** Domains the batched CRM leaves out of its answer — an adapter's bug, played. */
  crmUnanswered: new Set<string>(),
};

const targetList: TargetList = {
  provider: "memory-targets",
  async candidates() {
    return world.failing.has("candidates") ? down("candidates") : ok({ items: world.candidates, asOf: minutesAgo(10) });
  },
  async protectedAccounts() {
    return world.failing.has("protected") ? down("the protected set") : ok({ items: world.protected, asOf: minutesAgo(5) });
  },
  async freshness() {
    return world.failing.has("protected") ? down("the protected set") : ok({ asOf: minutesAgo(5) });
  },
} as unknown as TargetList;

const peopleSource: PeopleSource = {
  provider: "memory-people",
  async peopleAt({ company }) {
    const domain = company.keys.find((k) => k.kind === "domain")?.value ?? "";
    world.searched.push(domain);
    return ok({
      asOf: minutesAgo(60),
      items: (world.people.get(domain) ?? []).map((p) => ({
        identity: {
          subject: "person",
          keys: [
            { kind: "social_profile_id", network: "net_a", value: p.id },
            { kind: "social_profile_handle", network: "net_a", value: p.handle },
            ...(p.known ? [{ kind: "email", value: p.known }] : []),
          ],
        },
        display: { fullName: p.name },
      })),
    });
  },
};

/** A paid source: one credit per address found, the way the real one counts. */
const enrichment: Enrichment = {
  provider: "memory-paid",
  finds: ["email"],
  async complete({ identity }, ctx): Promise<CallResult<Completion>> {
    const handle = identity.keys.find((k) => k.kind === "social_profile_handle")?.value ?? "";
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: false, asOf: NOW.toISOString() } };
    world.completed.push(handle);
    const failure = world.completionError;
    if (failure === "unavailable") return { ok: false, error: { code: "unavailable", message: "job job-42 (\"kernel run x\") was submitted and may have spent credits", retryable: false } };
    if (failure === "invalid") return { ok: false, error: { code: "invalid", message: "not a profile URL", retryable: false } };
    const someone = [...world.people.values()].flat().find((p) => p.handle === handle);
    if (!someone?.email) return ok({ found: false, asOf: NOW.toISOString(), cost: { amount: 0, unit: "credits" } });
    return ok({
      found: true,
      asOf: NOW.toISOString(),
      attested: { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: someone.id }, { kind: "email", value: someone.email }] },
      said: [{ key: { kind: "email", value: someone.email }, status: someone.email.startsWith("any") ? "CATCH_ALL" : "DELIVERABLE" }],
      cost: { amount: 1, unit: "credits" },
    });
  },
};

const crm = {
  provider: "memory-crm",
  async findCompanyByDomain(domain: string) {
    world.crmCalls++;
    if (world.failing.has("crm")) return down("the CRM");
    return ok(world.crmCompanies.has(domain) ? { ref: { externalId: `crm-${domain}` }, domain, fields: {} } : null);
  },
  async findPersonByEmail(email: string) {
    world.crmCalls++;
    if (world.failing.has("crm") || world.failing.has("crm-people")) return down("the CRM");
    return ok(world.crmPeople.has(email) ? { ref: { externalId: `crm-${email}` }, email, fields: {} } : null);
  },
} as unknown as Crm;

/** The same CRM, able to answer for many domains in one call — and never asked one at a time. */
const batchedCrm = {
  ...crm,
  async findCompanyByDomain() {
    throw new Error("asked one domain at a time, though it answers for many");
  },
  async findCompaniesByDomains(domains: readonly string[]) {
    world.crmBatches.push([...domains]);
    if (world.failing.has("crm")) return down("the CRM");
    return ok(
      new Map(
        domains
          .filter((d) => !world.crmUnanswered.has(d))
          .map((d) => [d, world.crmCompanies.has(d) ? { ref: { externalId: `crm-${d}` }, domain: d, fields: {} } : null]),
      ),
    );
  },
} as unknown as Crm;

const registry: Registry = {
  get: (c) => ({ target_list: targetList, people_source: peopleSource, crm: world.crmBatched ? batchedCrm : crm } as Record<string, Contract>)[c],
  require: () => {
    throw new Error("not used");
  },
  forChannel: () => undefined,
  all: () => [],
  sequence: <T extends Contract>(c: string) => (c === "enrichment" ? [{ adapter: enrichment as unknown as T, provider: "memory-paid", finds: ["email"], index: 0 }] : []),
  list: () => [],
};

const relationsDomain = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest;
if (!relationsDomain) throw new Error("relations/domain.yaml does not load");
const identity = identityVocabulary([relationsDomain], ["net_a"]);

const request = (over: Partial<SourceRequest> = {}): SourceRequest => ({
  maxPeople: 10,
  want: ["email"],
  protectedMaxAgeMinutes: 60,
  dryRun: false,
  trigger: "cli",
  actor: { type: "system", id: "test" },
  ...over,
});
const run = (over: Partial<SourceRequest> = {}) => source({ db, registry, identity, now: () => NOW }, request(over));

const recorded = async () => (await client.query("select email from relations.person order by email")).rows.map((r) => r.email as string);
const outcomes = async (runId: string) =>
  (await client.query("select pass, outcome, person_id is not null as has_person from gtm.sourcing_result where run_id = $1 order by created_at, id", [runId])).rows as {
    pass: string;
    outcome: string;
    has_person: boolean;
  }[];
const runRow = async (id: string) => (await client.query("select status, dry_run, error from core.run where id = $1", [id])).rows[0] as { status: string; dry_run: boolean; error: string | null };
const kept = (r: Awaited<ReturnType<typeof run>>) => r.looked.filter((l) => l.outcome === "kept").map((l) => l.person?.keys.find((k) => k.kind === "email")?.value);

beforeEach(async () => {
  if (client) await client.query("truncate gtm.sourcing_result, relations.person, relations.company, core.run cascade");
  world.candidates = [{ domain: "open.example.com", attributes: {} }];
  world.protected = [{ domain: "customer.example.org", reason: "customer" }];
  world.people = new Map([
    [
      "open.example.com",
      [
        { id: "101", handle: "ada", name: "Ada", email: "ada@open.example.com" },
        { id: "102", handle: "bo", name: "Bo", email: "bo@open.example.com" },
      ],
    ],
  ]);
  world.crmCompanies = new Set();
  world.crmPeople = new Set();
  world.failing = new Set();
  world.completionError = undefined;
  world.searched = [];
  world.completed = [];
  world.crmCalls = 0;
  world.crmBatched = false;
  world.crmBatches = [];
  world.crmUnanswered = new Set();
});

/* -------------------------------------------------------------------------- */

describe("the sourcing path", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("sources, completes and records the people it keeps, with what was said and what it cost", async () => {
    world.people.get("open.example.com")![1]!.email = "any@open.example.com";
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(kept(r), ["ada@open.example.com", "any@open.example.com"]);
    assert.deepEqual(await recorded(), ["ada@open.example.com", "any@open.example.com"]);
    assert.deepEqual(r.spent, [{ provider: "memory-paid", amount: 2, unit: "credits" }]);
    assert.deepEqual(r.looked[1]?.said?.map((s) => s.status), ["CATCH_ALL"]);
    assert.deepEqual(await outcomes(r.runId), [
      { pass: "person", outcome: "kept", has_person: true },
      { pass: "person", outcome: "kept", has_person: true },
    ]);
    assert.equal((await runRow(r.runId)).status, "succeeded");
  });
});

describe("the company pass, before anything is spent", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("excludes a protected company and never looks up its people", async () => {
    world.candidates.push({ domain: "customer.example.org", attributes: {} });
    world.people.set("customer.example.org", [{ id: "201", handle: "cy", name: "Cy", email: "cy@elsewhere.example.net" }]);
    const r = await run();
    assert.deepEqual(world.searched, ["open.example.com"]);
    assert.ok(!world.completed.includes("cy"), "a protected company's person was paid for");
    assert.deepEqual(r.looked.filter((l) => l.pass === "company").map((l) => [l.outcome, l.company.domain]), [["protected", "customer.example.org"]]);
  });

  it("excludes a company the CRM knows and never looks up its people, saying what that spared", async () => {
    world.candidates.push({ domain: "client.example.net", attributes: {} });
    world.people.set("client.example.net", [{ id: "301", handle: "dee", name: "Dee", email: "dee@client.example.net" }]);
    world.crmCompanies.add("client.example.net");
    const r = await run({ peoplePerCompany: 3 });
    assert.deepEqual(world.searched, ["open.example.com"]);
    assert.ok(!world.completed.includes("dee"), "a CRM-known company's person was paid for");
    assert.ok(!(await recorded()).includes("dee@client.example.net"), "a CRM-known company's person was recorded");
    const excluded = r.looked.find((l) => l.company.domain === "client.example.net");
    assert.deepEqual([excluded?.pass, excluded?.outcome], ["company", "known_to_crm"]);
    assert.deepEqual(r.avoidedByCompanyPass, { companies: 1, peopleSearches: 1, completionsAtMost: 3 });
  });

  // The domain is open and unknown to the CRM: only the company id is protected.
  it("excludes a company protected by its company id alone, and never looks up its people", async () => {
    const id = { kind: "social_company_id", network: "net_a", value: "4242" };
    world.candidates = [{ domain: "open.example.com", identity: { subject: "company", keys: [{ kind: "domain", value: "open.example.com" }, id] }, attributes: {} }];
    world.protected = [{ domain: "client.example.net", identity: { subject: "company", keys: [{ kind: "domain", value: "client.example.net" }, id] }, reason: "customer" }];
    const r = await run();
    assert.deepEqual([world.searched, world.completed], [[], []]);
    assert.deepEqual(r.looked.map((l) => [l.pass, l.outcome]), [["company", "protected"]]);
    const kept = (await client.query("select company from gtm.sourcing_result where run_id = $1", [r.runId])).rows[0]?.company;
    assert.deepEqual(kept?.identity?.keys, [{ kind: "domain", value: "open.example.com" }, id], "the company's keys were not kept with the outcome");
  });

  it("stops before anything is spent when the CRM cannot answer", async () => {
    world.failing.add("crm");
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /the CRM could not be read, so nothing was spent/);
    assert.deepEqual([world.searched, world.completed], [[], []]);
    assert.deepEqual(await recorded(), []);
    assert.equal((await runRow(r.runId)).status, "failed");
  });

  it("records a CRM refusal whole in the run, however long: the provider is quoted, not paraphrased", async () => {
    const verbatim = `rate limited — the provider's response, verbatim: status 429; headers: ${"x-padding: abc; ".repeat(60)}x-query-score: 145; body: {"code":"rate_limit_exceeded"}`;
    const real = crm.findCompanyByDomain.bind(crm);
    crm.findCompanyByDomain = async () => ({ ok: false, error: { code: "rate_limited", message: verbatim, retryable: true } });
    try {
      const r = await run();
      assert.equal(r.status, "failed");
      const recorded = (await runRow(r.runId)).error ?? "";
      assert.ok(recorded.length > 500, `the run kept ${recorded.length} characters`);
      assert.ok(recorded.endsWith(verbatim), "the run did not keep the provider's answer whole");
    } finally {
      crm.findCompanyByDomain = real;
    }
  });

  it("stops before asking the CRM or anyone when protection cannot be read", async () => {
    world.failing.add("protected");
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /protection unavailable/);
    assert.deepEqual([world.crmCalls, world.searched.length, world.completed.length], [0, 0, 0]);
  });

  it("checks every candidate against the CRM before the first search", async () => {
    world.candidates.push({ domain: "late.example.com", attributes: {} });
    // The CRM fails on the second company: the first company's people must not
    // have been searched or paid for yet.
    let calls = 0;
    const real = crm.findCompanyByDomain.bind(crm);
    crm.findCompanyByDomain = async (d, c) => (++calls === 2 ? down("the CRM") : real(d, c));
    try {
      const r = await run();
      assert.equal(r.status, "failed");
      assert.deepEqual([world.searched, world.completed], [[], []]);
    } finally {
      crm.findCompanyByDomain = real;
    }
  });
});

describe("the company pass, in one read of the CRM", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(() => {
    world.crmBatched = true;
  });

  it("asks once about every distinct domain protection left, and excludes the known ones in the candidates' order", async () => {
    world.candidates.push(
      { domain: "customer.example.org", attributes: {} },
      { name: "No Domain", attributes: {} },
      { domain: "known.example.com", attributes: {} },
      { domain: "https://www.Known.example.com/about", attributes: {} },
    );
    world.crmCompanies.add("known.example.com");
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(world.crmBatches, [["open.example.com", "known.example.com"]]);
    assert.deepEqual(r.looked.filter((l) => l.pass === "company").map((l) => [l.outcome, l.company.domain ?? l.company.name]), [
      ["protected", "customer.example.org"],
      ["unreachable", "No Domain"],
      ["known_to_crm", "known.example.com"],
      ["known_to_crm", "https://www.Known.example.com/about"],
    ]);
    assert.deepEqual(world.searched, ["open.example.com"]);
  });

  it("stops before anything is spent when that read fails", async () => {
    world.failing.add("crm");
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /the CRM could not be read, so nothing was spent: unavailable: the CRM is down/);
    assert.deepEqual([world.searched, world.completed], [[], []]);
  });

  // open.example.com is neither protected nor known: only the guard on a
  // missing answer stands between it and a search.
  it("stops, concluding nothing, when the answer leaves a domain out: unanswered is not unknown", async () => {
    world.crmUnanswered.add("open.example.com");
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /gave no answer for open\.example\.com/);
    assert.deepEqual([world.searched, world.completed], [[], []]);
  });

  it("asks nothing when protection left no domain to ask about", async () => {
    world.candidates = [{ domain: "customer.example.org", attributes: {} }];
    const r = await run();
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual(world.crmBatches, []);
  });
});

describe("the person pass, on the completed identity", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  // Bo has no address until completion gives one on a protected domain. The
  // company is open and the CRM knows nothing, so only protection asked
  // again, after completion, can stop Bo.
  it("replays protection after completion: an address it was given on a protected domain excludes the person", async () => {
    world.people.get("open.example.com")![1]!.email = "bo@customer.example.org";
    const r = await run();
    assert.deepEqual(kept(r), ["ada@open.example.com"]);
    assert.ok(!(await recorded()).includes("bo@customer.example.org"), "a protected person was recorded");
    const bo = r.looked.find((l) => l.person?.keys.some((k) => k.value === "bo@customer.example.org"));
    assert.deepEqual([bo?.pass, bo?.outcome], ["person", "protected"]);
    assert.deepEqual(r.spentOnExcludedPeople, [{ provider: "memory-paid", amount: 1, unit: "credits" }]);
  });

  it("excludes a person the CRM knows by the address completion found", async () => {
    world.crmPeople.add("bo@open.example.com");
    const r = await run();
    assert.deepEqual(kept(r), ["ada@open.example.com"]);
    assert.ok(!(await recorded()).includes("bo@open.example.com"), "a CRM-known person was recorded");
    assert.equal(r.looked.find((l) => l.outcome === "known_to_crm")?.pass, "person");
  });

  it("stops when the CRM cannot answer for a person, recording nobody further", async () => {
    world.failing.add("crm-people");
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /the CRM could not be read/);
    assert.deepEqual(await recorded(), []);
    assert.equal(world.completed.length, 1, "the run went on paying after the CRM went quiet");
  });

  it("excludes a person who opted out", async () => {
    await client.query("insert into relations.person (email, external_id, opted_out_at) values ('bo@open.example.com', 'net_a:102', now())");
    const r = await run();
    assert.deepEqual(kept(r), ["ada@open.example.com"]);
    assert.equal(r.looked.find((l) => l.outcome === "opted_out")?.pass, "person");
  });

  it("excludes a person completion found no address for, as incomplete, recording nobody", async () => {
    delete world.people.get("open.example.com")![1]!.email;
    const r = await run();
    assert.deepEqual(kept(r), ["ada@open.example.com"]);
    assert.equal(r.looked.find((l) => l.outcome === "incomplete")?.person?.keys.find((k) => k.kind === "social_profile_handle")?.value, "bo");
    assert.deepEqual(await recorded(), ["ada@open.example.com"]);
  });
});

describe("what is paid for", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("completes no more than maxPeople, and says who was not reached", async () => {
    world.people.get("open.example.com")!.push({ id: "103", handle: "cy", name: "Cy", email: "cy@open.example.com" });
    const r = await run({ maxPeople: 2 });
    assert.equal(world.completed.length, 2);
    assert.equal(r.looked.filter((l) => l.outcome === "not_reached").length, 1);
  });

  it("refuses a run without a ceiling", async () => {
    await assert.rejects(run({ maxPeople: 0 }), /maxPeople must be a positive whole number/);
  });

  it("stops at a provider-level failure, naming the job, and pays for nobody after it", async () => {
    world.completionError = "unavailable";
    const r = await run();
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy ?? "", /job-42/);
    assert.equal(world.completed.length, 1, "another person was paid for after the provider failed");
    const row = (await client.query("select detail from gtm.sourcing_result where run_id = $1 and outcome = 'unreachable'", [r.runId])).rows[0];
    assert.match(row?.detail ?? "", /job-42/, "the job's id was not kept with the run");
  });

  it("goes on after a failure that is the person's, not the provider's", async () => {
    world.completionError = "invalid";
    const r = await run();
    assert.equal(r.status, "succeeded");
    assert.equal(world.completed.length, 2);
  });

  it("counts as sent to a source only the people a source was asked about", async () => {
    const r = await run({ want: ["social_profile_id"] });
    assert.deepEqual([r.peopleTaken, r.completions], [2, 0]);
    // A fresh cursor: otherwise the second run skips what the first examined (0043).
    await client.query("truncate gtm.sourcing_result");
    const paid = await run();
    assert.deepEqual([paid.peopleTaken, paid.completions], [2, 2]);
  });

  it("does not pay twice for a person met twice in the run", async () => {
    world.candidates.push({ domain: "twin.example.com", attributes: {} });
    world.people.set("twin.example.com", [{ id: "101", handle: "ada", name: "Ada", email: "ada@open.example.com" }]);
    const r = await run();
    assert.deepEqual(world.completed, ["ada", "bo"]);
    assert.equal(r.avoidedBeforeCompletion, 1);
  });
});

describe("before paying", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("does not pay for a person whose address, given by the people source, is already protected", async () => {
    world.people.get("open.example.com")!.push({ id: "104", handle: "eve", name: "Eve", known: "eve@customer.example.org", email: "eve@customer.example.org" });
    const r = await run();
    assert.ok(!world.completed.includes("eve"), "a person already known to be protected was paid for");
    const eve = r.looked.find((l) => l.person?.keys.some((k) => k.value === "eve@customer.example.org"));
    assert.deepEqual([eve?.outcome, eve?.detail], ["protected", "an address it already had is on a protected domain; not completed"]);
    assert.equal(r.avoidedBeforeCompletion, 1);
  });

  it("excludes a person left with no address: neither protection nor the CRM can conclude about them", async () => {
    // Asking for a key the person already has: nothing is completed, and no
    // address ever arrives.
    const r = await run({ want: ["social_profile_id"] });
    assert.deepEqual(world.completed, []);
    assert.deepEqual(r.looked.map((l) => l.outcome), ["unreachable", "unreachable"]);
    assert.match(r.looked[0]?.detail ?? "", /no address: neither protection nor the CRM/);
    assert.deepEqual(await recorded(), []);
  });
});

describe("a dry run", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("records nobody, pays for nothing, and keeps its outcomes", async () => {
    const r = await run({ dryRun: true });
    assert.equal(r.status, "succeeded", r.stoppedBy);
    assert.deepEqual([world.completed, await recorded()], [[], []]);
    assert.deepEqual((await outcomes(r.runId)).map((o) => o.outcome), ["simulated", "simulated"]);
    assert.equal((await runRow(r.runId)).dry_run, true);
  });
});

describe("the company pass asks only what the run needs (decision 0043)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const open = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ domain: `c${from + i}.example.com`, attributes: {} }));
  const asked = () => world.crmBatches.flat();

  beforeEach(() => {
    world.crmBatched = true;
    world.crmBatches = [];
    world.crmUnanswered = new Set();
    world.people = new Map();
  });

  it("wants what the ceiling needs, plus a quarter again, at least one", () => {
    assert.deepEqual([companiesWanted(10, 1), companiesWanted(2, 1), companiesWanted(10, 5), companiesWanted(1, 5)], [13, 3, 3, 2]);
  });

  it("stops after the batch in which enough companies survived", async () => {
    world.candidates = open(60);
    const r = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.deepEqual(r.companyPass, { wanted: 3, survived: 20, examined: 20, skippedAsExamined: 0, exhausted: false });
    assert.equal(asked().length, 20);
  });

  it("reads another batch while too few have survived", async () => {
    world.candidates = open(60);
    for (const c of open(20)) world.crmCompanies.add(c.domain);
    const r = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.deepEqual([r.companyPass.examined, r.companyPass.survived, world.crmBatches.length], [40, 20, 2]);
  });

  it("stops when the candidates run out first, says so, and goes on with what survived", async () => {
    world.candidates = open(5);
    for (const c of open(4)) world.crmCompanies.add(c.domain);
    const r = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.deepEqual(r.companyPass, { wanted: 3, survived: 1, examined: 5, skippedAsExamined: 0, exhausted: true });
    assert.deepEqual(world.searched, ["c4.example.com"]);
    assert.equal(r.status, "succeeded");
  });

  /** One person at each company, so that what is searched leaves rows. */
  const staffed = (n: number) => {
    world.candidates = open(n);
    world.people = new Map(open(n).map((c, i) => [c.domain, [{ id: `${200 + i}`, handle: `p${i}`, name: `P${i}`, email: `p${i}@${c.domain}` }]]));
  };

  it("does not ask again about what a previous live run examined", async () => {
    staffed(60);
    await run({ maxPeople: 2, peoplePerCompany: 1 });
    world.crmBatches = [];
    const second = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.ok(!asked().some((d) => ["c0.example.com", "c1.example.com"].includes(d)), `asked again: ${asked().slice(0, 3).join(", ")}`);
    assert.equal(second.companyPass.skippedAsExamined, 2);
  });

  it("counts a company the ceiling stopped before as not yet examined", async () => {
    staffed(60);
    const first = await run({ maxPeople: 2, peoplePerCompany: 1 });
    // Two companies were searched; the other eighteen that survived were not reached.
    assert.equal(first.looked.filter((l) => l.outcome === "not_reached").length, 18);
    world.crmBatches = [];
    await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.ok(asked().includes("c2.example.com"), "a company not reached was skipped as examined");
  });

  it("counts a company searched and found empty as examined", async () => {
    world.candidates = open(60);
    const first = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.equal(first.looked.filter((l) => l.pass === "company" && l.outcome === "kept").length, 20);
    world.crmBatches = [];
    const second = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.equal(second.companyPass.skippedAsExamined, 20);
    assert.ok(!asked().includes("c0.example.com"));
  });

  it("does not let a dry run advance the cursor", async () => {
    world.candidates = open(60);
    await run({ maxPeople: 2, peoplePerCompany: 1, dryRun: true });
    world.crmBatches = [];
    const live = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.equal(live.companyPass.skippedAsExamined, 0);
    assert.ok(asked().includes("c0.example.com"));
  });

  it("leaves no company row when the CRM fails in a later batch, not even the earlier batches'", async () => {
    world.candidates = [...open(20), ...open(20, 20)];
    for (const c of open(20)) world.crmCompanies.add(c.domain);
    world.crmUnanswered = new Set(["c25.example.com"]);
    const r = await run({ maxPeople: 2, peoplePerCompany: 1 });
    assert.match(r.stoppedBy ?? "", /gave no answer for c25\.example\.com/);
    assert.deepEqual(world.crmBatches.length, 2);
    assert.deepEqual(await outcomes(r.runId), []);
  });
});

describe("protection by ancestry, through the company pass (decision 0044)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("excludes a protected subdomain and an unreadable domain, each for its reason, and counts the hits", async () => {
    world.candidates = [
      { domain: "app.customer.example.org", attributes: {} },
      { domain: "bad domain.example.com", attributes: {} },
      { domain: "open.example.com", attributes: {} },
    ];
    const r = await run();
    const company = (d: string) => r.looked.find((l) => l.pass === "company" && l.company.domain === d);
    assert.deepEqual([company("app.customer.example.org")?.outcome, company("bad domain.example.com")?.outcome], ["protected", "unreadable_key"]);
    assert.deepEqual(r.protectionHits, [{ entry: "customer.example.org", candidates: 1 }]);
    assert.deepEqual(
      (await outcomes(r.runId)).filter((o) => o.pass === "company").map((o) => o.outcome).sort(),
      ["protected", "unreadable_key"],
    );
  });
});

describe("the person pass walks the ancestors of an address (decision 0044)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("excludes, after completion, a person whose address is on a subdomain of a protected domain", async () => {
    // The company is open; only the completed address, one level under a protected domain, can protect her.
    world.people.get("open.example.com")!.push({ id: "105", handle: "zoe", name: "Zoe", email: "zoe@mail.customer.example.org" });
    const r = await run();
    const zoe = r.looked.find((l) => l.person?.keys.some((k) => k.value === "zoe@mail.customer.example.org"));
    assert.deepEqual([zoe?.pass, zoe?.outcome, zoe?.detail], ["person", "protected", "an address completion gave it is on a protected domain"]);
    assert.ok(!kept(r).includes("zoe@mail.customer.example.org"), "a person on a protected subdomain was kept");
  });
});

describe("a kept person is at the company that was targeted (decision 0045)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const looked = (r: Awaited<ReturnType<typeof run>>, address: string) => r.looked.find((l) => l.person?.keys.some((k) => k.value === address));

  it("excludes, after completion, a person whose address is at another company — and asks the CRM nothing about them", async () => {
    // Listed at the targeted company by the people source; completion says they work elsewhere now.
    world.people.set("open.example.com", [{ id: "401", handle: "ivy", name: "Ivy", email: "ivy@elsewhere.example.net" }]);
    const r = await run();
    const ivy = looked(r, "ivy@elsewhere.example.net");
    assert.deepEqual([ivy?.pass, ivy?.outcome, ivy?.detail], ["person", "off_target", "its address is at elsewhere.example.net, not at open.example.com, the company targeted"]);
    // One lookup: the company's, in the company pass. None for the person.
    assert.equal(world.crmCalls, 1, "the CRM was asked about a person already excluded");
    assert.deepEqual(kept(r), []);
    assert.deepEqual(await recorded(), [], "a person off target was recorded");
  });

  it("keeps a person whose address is under the targeted company's domain", async () => {
    world.people.set("open.example.com", [{ id: "402", handle: "jo", name: "Jo", email: "jo@eu.open.example.com" }]);
    const r = await run();
    assert.deepEqual(kept(r), ["jo@eu.open.example.com"]);
  });

  it("needs every address at the targeted company, not one of them", () => {
    assert.deepEqual(addressesElsewhere(["kit@open.example.com", "kit@elsewhere.example.net"], "open.example.com"), ["elsewhere.example.net"]);
    assert.deepEqual(addressesElsewhere(["kit@open.example.com", "kit@eu.open.example.com"], "open.example.com"), []);
  });

  it("calls an address with no readable domain elsewhere: it cannot be shown to be at the company", () => {
    assert.deepEqual(addressesElsewhere(["kit@not a host"], "open.example.com"), ["not a host"]);
  });

  it("says protected first when an address is both protected and elsewhere", async () => {
    world.people.set("open.example.com", [{ id: "404", handle: "lu", name: "Lu", email: "lu@customer.example.org" }]);
    const r = await run();
    assert.equal(looked(r, "lu@customer.example.org")?.outcome, "protected");
  });

  it("does not file the person under the company their address names", async () => {
    world.people.set("open.example.com", [{ id: "405", handle: "mo", name: "Mo", email: "mo@elsewhere.example.net" }]);
    await run();
    assert.deepEqual((await client.query("select domain from relations.company")).rows, []);
  });
});
