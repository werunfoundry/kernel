/**
 * The enrolment that carries the kernel's messages (decision 0064): from a
 * sealed list, each person's approved drafts written through the message
 * gate, then handed to the sequencer as the variables its steps render —
 * after the provider's steps were held against the templates. Against a
 * real Postgres; the providers are in memory.
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
import { fingerprinter, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import { constituteList } from "@werunfoundry/relations/runtime/list";

import type { Enrolment, SequenceStep, Sequencer, SequencerDeclaration } from "../contracts/sequencer.js";
import type { ProtectedAccount, TargetList } from "../contracts/target-list.js";
import { approve, messageKey, propose } from "./draft.js";
import type { EnrolRequest } from "./enrol.js";
import { enrol } from "./enrol.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_enrol_list_${process.pid}`;
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

const relations = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!;
const identity = identityVocabulary([relations]);
const register = fingerprinter("T1", { T1: generateSecret() }, [], identity);
const DAY = 24 * 60;

/* The providers ------------------------------------------------------------ */

const world = {
  protected: [] as ProtectedAccount[],
  /** The provider's steps of the sequence, as `readSteps` answers them. */
  steps: [] as SequenceStep[],
  /** Every enrolment handed to the sequencer, live or simulated. */
  enrolments: [] as Enrolment[],
  held: new Map<string, string>(),
};
const ok = <T>(value: T): CallResult<T> => ({ ok: true, value });
const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value ?? "";

const targetList: TargetList = {
  provider: "memory-targets",
  async freshness(route) {
    return ok({ route, asOf: new Date().toISOString() });
  },
  async candidates() {
    return ok({ items: [] });
  },
  async protectedAccounts() {
    return ok({ items: world.protected });
  },
};

const reads: SequencerDeclaration = {
  enrol: { serves: "yes" },
  pullTouches: { serves: "no", why: "not in this test" },
  suspend: { serves: "yes", method: "letting go of the person", costs: { person: [], sequence: [] }, gap: { known: true, minutes: 0, basis: "by construction", measuredOn: "2026-10-22" } },
  pullUnsubscribes: { serves: "no", why: "not in this test" },
  readSteps: { serves: "yes" },
};
let declares: SequencerDeclaration = reads;

const sequencer: Sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  get declares() {
    return declares;
  },
  async readSteps(sequenceKey) {
    return ok({ sequenceKey, steps: world.steps, asOf: new Date().toISOString() });
  },
  async enrol(e, ctx) {
    world.enrolments.push(e);
    if (!ctx.dryRun) world.held.set(e.idempotencyKey, emailOf(e.person));
    return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { state: "active", idempotencyKey: e.idempotencyKey, asOf: new Date().toISOString() } };
  },
  async withdraw({ idempotencyKey }) {
    world.held.delete(idempotencyKey);
    return ok({ found: true, asOf: new Date().toISOString() });
  },
  async suppress() {
    return ok({ applied: [], notApplicable: [], asOf: new Date().toISOString() });
  },
  async status({ person }) {
    const key = [...world.held.entries()].find(([, e]) => e === emailOf(person))?.[0];
    return ok({ state: key ? "active" : "unknown", ...(key ? { idempotencyKey: key } : {}), asOf: new Date().toISOString() });
  },
  async capacity({ sender, channel }) {
    return ok({ sender, channel, limits: [], asOf: new Date().toISOString() });
  },
};

const registry = {
  get: (c: string) => (c === "target_list" ? targetList : undefined),
  forChannel: (c: string, ch: string) => (c === "sequencer" && ch === "email" ? sequencer : undefined),
  all: (c: string) => (c === "sequencer" ? [sequencer] : []),
} as unknown as Registry;

/* Fixtures ------------------------------------------------------------------ */

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
const human = { actor: { type: "human" as const, id: "an operator" } };

beforeEach(async () => {
  if (!client) return;
  await client.query("truncate relations.touch, relations.message, relations.list, relations.person, relations.company, acquisition.draft, acquisition.template, acquisition.enrolment_skip, acquisition.enrolment, core.experiment, core.run cascade");
  world.protected = [];
  world.enrolments = [];
  world.held.clear();
  declares = reads;
  // Two steps, the second three days after the first, each rendering its own variables.
  world.steps = [
    { step: 1, channel: "email", afterPreviousMinutes: 0, subject: { variable: "engine_subject_1" }, body: { variable: "engine_body_1" }, variants: 1 },
    { step: 2, channel: "email", afterPreviousMinutes: 3 * DAY, subject: null, body: { variable: "engine_body_2" }, variants: 1 },
  ];
});

/** A person at a company, both recorded. */
async function aPerson(email: string, domain: string, optedOut = false): Promise<string> {
  const c = await one("insert into relations.company (name, domain) values ($1, $1) on conflict do nothing returning id", [domain]);
  const companyId = c?.id ?? (await one("select id from relations.company where domain = $1", [domain])).id;
  return (await one("insert into relations.person (email, full_name, company_id, opted_out_at) values ($1, 'Ada Example', $2, $3) returning id", [email, companyId, optedOut ? new Date() : null])).id;
}

/** A running reviewed experiment with a two-step plan in variant `a`, and a sealed list of these members. */
async function aCampaign(members: ({ personId: string } | { companyId: string })[]) {
  const experimentId = (await one("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('exp-0064', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).id as string;
  const t1 = (await one("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'Hello', 'One.') returning id", [experimentId])).id as string;
  const t2 = (await one("insert into acquisition.template (experiment_id, variant, step, channel, body, delay_days) values ($1, 'a', 2, 'email', 'Two.', 3) returning id", [experimentId])).id as string;
  const listRun = (await one("insert into core.run (process_key, trigger, actor_type, actor_id, dry_run) values ('acquisition.list.constitute', 'cli', 'human', 'an operator', false) returning id")).id as string;
  await constituteList(db, { key: "the-list", query: { from: "hand" }, members, actor: human.actor, runId: listRun });
  return { experimentId, templates: [t1, t2] };
}

/** One draft per step for the person, approved by a person unless told otherwise. */
async function drafted(experimentId: string, personId: string, templates: string[], approved: boolean[] = templates.map(() => true)) {
  const ids: string[] = [];
  for (const [i, templateId] of templates.entries()) {
    const p = await propose(db, register, { experimentId, personId, step: i + 1, templateId, ...(i === 0 ? { renderedSubject: "Hello Ada" } : {}), renderedBody: `Step ${i + 1}, for Ada.` }, { actor: { type: "agent", id: "a drafting agent" } }, { autonomyAfter: 5 });
    assert.ok(p.ok, JSON.stringify(p));
    if (approved[i]) assert.ok((await approve(db, p.draft.id, { by: "an operator" }, human)).ok);
    ids.push(p.draft.id);
  }
  return ids;
}

const request = (experimentId: string, over: Partial<NonNullable<EnrolRequest["fromList"]>> = {}, more: Partial<EnrolRequest> = {}): EnrolRequest => ({
  sequenceKey: "welcome",
  channel: "email",
  fromList: { listKey: "the-list", experimentId, unsolicited: false, ...over },
  protectedMaxAgeMinutes: 60,
  dryRun: false,
  trigger: "cli",
  actor: { type: "system", id: "the enrolment" },
  ...more,
});
const run = (r: EnrolRequest) => enrol({ db, registry, identity, fingerprints: register }, r);
const skipsOf = async (runId: string) => (await rows("select reason, detail from acquisition.enrolment_skip where run_id = $1", [runId])).map((r) => [r.reason as string, r.detail as string]).sort((a, b) => a[0]!.localeCompare(b[0]!));

/* -------------------------------------------------------------------------- */

describe("an enrolment from a list carries the kernel's messages (0064)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes each step's message through the gate, then hands the sequencer the variables its steps render", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    const drafts = await drafted(experimentId, ada, templates);
    const r = await run(request(experimentId));
    assert.equal(r.stoppedBy, undefined);
    assert.equal(r.enrolled.length, 1);
    assert.equal(world.enrolments.length, 1);
    assert.deepEqual(world.enrolments[0]!.variables, { engine_subject_1: "Hello Ada", engine_body_1: "Step 1, for Ada.", engine_body_2: "Step 2, for Ada." });
    assert.deepEqual(world.enrolments[0]!.attribution, { runId: r.runId, experimentSlug: "exp-0064", variant: "a" });
    assert.deepEqual(
      await rows("select key, subject, body, unsolicited, approved_by from relations.message order by key"),
      [
        { key: messageKey(drafts[0]!), subject: "Hello Ada", body: "Step 1, for Ada.", unsolicited: false, approved_by: "an operator" },
        { key: messageKey(drafts[1]!), subject: null, body: "Step 2, for Ada.", unsolicited: false, approved_by: "an operator" },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
    assert.equal((await one("select state from acquisition.enrolment")).state, "enrolled");
  });

  it("refuses an unsolicited enrolment before any run, until the cap is judged ahead (0064 §3)", async () => {
    const { experimentId } = await aCampaign([]);
    await assert.rejects(run(request(experimentId, { unsolicited: true })), /capped over its whole plan before it is made \(decision 0064 §3\), and that cap is not built yet/);
    assert.equal((await one("select count(*)::int as n from core.run where process_key like 'acquisition.enrol.%'")).n, 0);
  });

  it("refuses, before any run, a sequencer that does not read its steps (0064 §5)", async () => {
    const { experimentId } = await aCampaign([]);
    declares = { ...reads, readSteps: { serves: "no", why: "not built" } };
    await assert.rejects(run(request(experimentId)), /does not read a sequence's steps/);
    const { readSteps: _, ...silent } = reads;
    declares = silent;
    await assert.rejects(run(request(experimentId)), /does not read a sequence's steps/);
  });

  it("stops the run, reaching nobody and writing no message, when the provider's steps disagree with the templates", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    await drafted(experimentId, ada, templates);
    world.steps = [world.steps[0]!];
    const r = await run(request(experimentId));
    assert.match(r.stoppedBy ?? "", /the templates of variant "a" disagree, so the plan would not be the one run \(decision 0064 §5\): the provider runs 1 step\(s\) of "welcome", and the templates plan 2/);
    assert.deepEqual(world.enrolments, []);
    assert.equal((await one("select count(*)::int as n from relations.message")).n, 0);
  });

  it("stops the run when the sequence runs a step on another channel than the enrolment's", async () => {
    const { experimentId } = await aCampaign([]);
    world.steps = [{ ...world.steps[0]!, channel: "social" }, world.steps[1]!];
    const r = await run(request(experimentId));
    assert.match(r.stoppedBy ?? "", /runs steps on "social", and this enrolment is on "email"/);
  });

  it("skips a person whose every step is not approved, writing no message and reaching nobody", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    await drafted(experimentId, ada, templates, [true, false]);
    const r = await run(request(experimentId));
    assert.deepEqual(await skipsOf(r.runId), [["not_drafted", "no approved draft for step 2: every step of the sequence carries one (decision 0064)"]]);
    assert.deepEqual(world.enrolments, []);
    assert.equal((await one("select count(*)::int as n from relations.message")).n, 0);
    assert.equal((await one("select count(*)::int as n from acquisition.enrolment")).n, 0);
  });

  it("skips a person whose approved drafts belong to two variants: no one plan is theirs", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    const b1 = (await one("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'b', 1, 'email', 'Hi', 'Uno.') returning id", [experimentId])).id as string;
    await one("insert into acquisition.template (experiment_id, variant, step, channel, body, delay_days) values ($1, 'b', 2, 'email', 'Dos.', 3) returning id", [experimentId]);
    await drafted(experimentId, ada, [b1, templates[1]!]);
    const r = await run(request(experimentId));
    assert.deepEqual(await skipsOf(r.runId), [["not_drafted", "approved drafts of 2 variants: every step of the sequence carries one (decision 0064)"]]);
    assert.deepEqual(world.enrolments, []);
  });

  it("skips a person with no approved draft at all", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    await drafted(experimentId, ada, templates, [false, false]);
    const r = await run(request(experimentId));
    assert.deepEqual(await skipsOf(r.runId), [["not_drafted", "no approved draft: every step of the sequence carries one (decision 0064)"]]);
  });

  it("skips a person whose message the gate refuses, and reaches nobody", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    const drafts = await drafted(experimentId, ada, templates);
    // An approval by the autonomous lane, on an experiment whose lane is reviewed: the gate's lane refuses it.
    await client.query("update acquisition.draft set decided_by = 'lane:autonomous' where id = $1", [drafts[0]]);
    const r = await run(request(experimentId));
    const skips = await skipsOf(r.runId);
    assert.equal(skips.length, 1);
    assert.equal(skips[0]![0], "refused");
    assert.match(skips[0]![1]!, /the message gate refused, so nobody is reached \(decision 0038\): step 1: lane/);
    assert.deepEqual(world.enrolments, []);
    assert.equal((await one("select count(*)::int as n from acquisition.enrolment")).n, 0);
  });

  it("in a dry run, writes no message and no registry row, and shows what it would hand over", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    await drafted(experimentId, ada, templates);
    const r = await run(request(experimentId, {}, { dryRun: true }));
    assert.equal(r.enrolled.length, 1);
    assert.deepEqual(Object.keys(world.enrolments[0]!.variables ?? {}).sort(), ["engine_body_1", "engine_body_2", "engine_subject_1"]);
    assert.equal(world.held.size, 0);
    assert.equal((await one("select count(*)::int as n from relations.message")).n, 0);
    assert.equal((await one("select count(*)::int as n from acquisition.enrolment")).n, 0);
  });

  it("still reads protection, the objection and the list's companies: a list is a selection, never a permission (0037)", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const bo = await aPerson("bo@client.example.org", "client.example.org");
    const cy = await aPerson("cy@example.net", "example.net", true);
    const companyOnly = (await one("insert into relations.company (name, domain) values ('lone', 'lone.example.com') returning id")).id as string;
    const { experimentId, templates } = await aCampaign([{ personId: ada }, { personId: bo }, { personId: cy }, { companyId: companyOnly }]);
    for (const p of [ada, bo]) await drafted(experimentId, p, templates);
    world.protected = [{ domain: "client.example.org" } as ProtectedAccount];
    const r = await run(request(experimentId));
    assert.deepEqual(world.enrolments.map((e) => emailOf(e.person)), ["ada@example.com"]);
    assert.deepEqual((await skipsOf(r.runId)).map(([reason]) => reason), ["opted_out", "protected", "unreachable"]);
  });

  it("keeps one message per draft when replayed, and enrols the person once", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templates } = await aCampaign([{ personId: ada }]);
    await drafted(experimentId, ada, templates);
    await run(request(experimentId));
    const again = await run(request(experimentId));
    assert.deepEqual((await skipsOf(again.runId)).map(([reason]) => reason), ["duplicate"]);
    assert.equal((await one("select count(*)::int as n from relations.message")).n, 2);
    assert.equal(world.held.size, 1);
  });
});
