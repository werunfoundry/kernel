/**
 * Tests for the sending path (decision 0050), against a real database: a
 * person crosses from a frozen list to a recorded touch, and the message's
 * gate is shown to stand on that path.
 *
 * Two seams, and what they hide (CLAUDE.md §5). The hand-over is a stub on
 * purpose: nothing in this decision reaches a provider, and the crossing with
 * a real sequencer does not exist yet — try-instance drives the published
 * package with a stub of its own, which is all that can cross today. The
 * target list is in memory, as in enrolment's tests; `readProtection` itself
 * is not.
 *
 * Every test asserts on what the hand-over *received*, not only on the
 * report: a report can say "refused" while the send went through.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import { constituteList } from "@werunfoundry/relations/runtime/list";

import type { ProtectedAccount, TargetList } from "../contracts/target-list.js";
import { approve } from "./draft.js";
import type { HandOver, SendRequest } from "./send.js";
import { draftFromList, messageKey, sendFromList } from "./send.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_send_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

const migrationsOf = (layer: string) => {
  const dir = join(import.meta.dirname, layer, "db/migrations");
  return readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));
};

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  for (const layer of ["../../../core", "../../relations", ".."]) for (const m of migrationsOf(layer)) await client.query(m.sql);
  db = drizzle(client) as unknown as Database;
});

after(async () => {
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

/* An instance's world, in memory ------------------------------------------- */

const world = {
  protected: [] as ProtectedAccount[],
  protectedAsOf: () => new Date().toISOString(),
  /** Every message the stub was handed, in order. */
  handed: [] as { idempotencyKey: string; email: string; body: string }[],
  /** How the next hand-over fails, if it does. */
  fail: undefined as "retryable" | "refused" | undefined,
};

const ok = <T>(value: T): CallResult<T> => ({ ok: true, value });

const targetList: TargetList = {
  provider: "memory-targets",
  async freshness(route) {
    return ok({ route, asOf: route === "protected" ? world.protectedAsOf() : new Date().toISOString() });
  },
  async candidates() {
    return ok({ items: [] });
  },
  async protectedAccounts() {
    return ok({ items: world.protected });
  },
};

/** The stub where the sequencer will be. It sends nothing: it remembers. Idempotent on the key. */
const stub: HandOver = {
  provider: "stub-handover",
  async handOver(m) {
    const fail = world.fail;
    world.fail = undefined;
    if (fail === "retryable") return { ok: false, error: { code: "unavailable", message: "the stub is down", retryable: true } };
    if (fail === "refused") return { ok: false, error: { code: "invalid", message: "the stub refuses this address", retryable: false } };
    if (!world.handed.some((h) => h.idempotencyKey === m.idempotencyKey)) {
      world.handed.push({ idempotencyKey: m.idempotencyKey, email: m.person.keys.find((k) => k.kind === "email")?.value ?? "", body: m.body });
    }
    return ok({ providerEventId: `stub-event:${m.idempotencyKey}`, at: new Date().toISOString() });
  },
};

const registry: Registry = {
  get: (c) => ({ target_list: targetList } as Record<string, Contract>)[c],
  require: () => {
    throw new Error("not used");
  },
  forChannel: () => undefined,
  all: () => [],
  sequence: () => [],
  list: () => [],
};

/* Fixtures ------------------------------------------------------------------ */

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

beforeEach(async () => {
  if (!client) return;
  await client.query("truncate relations.touch, relations.message, relations.list, relations.person, relations.company, acquisition.draft, acquisition.template, core.experiment, core.run cascade");
  world.protected = [];
  world.protectedAsOf = () => new Date().toISOString();
  world.handed = [];
  world.fail = undefined;
});

/** A person at a company, both recorded. */
async function aPerson(email: string, domain: string): Promise<string> {
  const c = await one("insert into relations.company (name, domain) values ($1, $1) on conflict do nothing returning id", [domain]);
  const companyId = c?.id ?? (await one("select id from relations.company where domain = $1", [domain])).id;
  return (await one("insert into relations.person (email, full_name, company_id) values ($1, 'Ada Example', $2) returning id", [email, companyId])).id;
}

/** A running reviewed experiment, its one-step email template, and a sealed list of these members. */
async function aCampaign(members: ({ personId: string } | { companyId: string })[]) {
  const experimentId = (await one("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values (gen_random_uuid()::text, 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).id as string;
  const templateId = (await one("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'Hello', 'A first line.') returning id", [experimentId])).id as string;
  const listRun = (await one("insert into core.run (process_key, trigger, actor_type, actor_id, dry_run) values ('acquisition.list.constitute', 'cli', 'human', 'an operator', false) returning id")).id as string;
  await constituteList(db, { key: "the-list", query: { from: "hand" }, members, actor: { type: "human", id: "an operator" }, runId: listRun });
  return { experimentId, templateId };
}

const compose = (_p: unknown, t: { subject?: string; body: string }) => ({ ...(t.subject ? { subject: t.subject } : {}), body: t.body });
const agent = { type: "agent" as const, id: "a drafting agent" };

/** Run 1, then a person approves every draft it proposed. */
async function draftAndApprove(experimentId: string, templateId: string) {
  const drafted = await draftFromList(db, { listKey: "the-list", experimentId, templateId, compose, gate: { autonomyAfter: 5 }, dryRun: false, trigger: "cli", actor: agent });
  for (const d of drafted.drafted) {
    const a = await approve(db, d.draftId!, { by: "an operator" }, { actor: { type: "human", id: "an operator" } });
    assert.ok(a.ok, "the approval was refused");
  }
  return drafted;
}

const sendRequest = (experimentId: string, over: Partial<SendRequest> = {}): SendRequest => ({
  listKey: "the-list",
  experimentId,
  unsolicited: true,
  cap: { max: 1, withinDays: 30 },
  protectedMaxAgeMinutes: 60,
  dryRun: false,
  trigger: "cli",
  actor: { type: "system", id: "the sending path" },
  ...over,
});
const send = (experimentId: string, over: Partial<SendRequest> = {}) => sendFromList({ db, registry, handOver: stub }, sendRequest(experimentId, over));

/** An unsolicited outbound touch nobody wrote a message for: a send the sequencer made on its own. */
const aSequencerSend = (personId: string) =>
  client.query(
    "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', true, 'a-sequencer', gen_random_uuid()::text, now(), 'system')",
    [personId],
  );

const counts = async () => ({
  messages: (await one("select count(*)::int as n from relations.message")).n as number,
  touches: (await one("select count(*)::int as n from relations.touch where direction = 'outbound' and message_id is not null")).n as number,
});

/* -------------------------------------------------------------------------- */

describe("the sending path", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("takes a person from a list to a recorded touch, through the message's gate", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);

    const drafted = await draftAndApprove(experimentId, templateId);
    assert.deepEqual(drafted.drafted.map((d) => d.outcome), ["awaiting_review"], "a reviewed lane waits on a person");

    const r = await send(experimentId);
    assert.equal(r.status, "succeeded");
    assert.deepEqual(r.drafts.map((d) => d.outcome), ["sent"]);
    const draftId = drafted.drafted[0]!.draftId!;

    // The gate's record: the message, under the draft's key, naming who approved it.
    const message = await one("select id, key, person_id, channel, unsolicited, approved_by, actor_type, run_id from relations.message");
    assert.deepEqual(
      { ...message, id: undefined },
      { id: undefined, key: messageKey(draftId), person_id: personId, channel: "email", unsolicited: true, approved_by: "an operator", actor_type: "system", run_id: r.runId },
    );
    // Handed over once, under the message's key, after the message was written.
    assert.deepEqual(world.handed, [{ idempotencyKey: messageKey(draftId), email: "ada@example.com", body: "A first line." }]);
    // The touch names its message, and keeps the provider's id as the provider's.
    const touch = await one("select direction, unsolicited, channel, provider, provider_event_id, message_id, experiment_id, run_id from relations.touch");
    assert.deepEqual(touch, {
      direction: "outbound",
      unsolicited: true,
      channel: "email",
      provider: "stub-handover",
      provider_event_id: `stub-event:${messageKey(draftId)}`,
      message_id: message.id,
      experiment_id: experimentId,
      run_id: r.runId,
    });
    assert.equal((await one("select state from acquisition.draft where id = $1", [draftId])).state, "sent");
    // Both runs are recorded, by what they are.
    const runs = await rows("select process_key, status, trigger from core.run where process_key in ('acquisition.draft', 'acquisition.send') order by started_at");
    assert.deepEqual(runs, [
      { process_key: "acquisition.draft", status: "succeeded", trigger: "cli" },
      { process_key: "acquisition.send", status: "succeeded", trigger: "cli" },
    ]);

    // The proof the gate stood on this path, and read what the path recorded:
    // the next step to the same person, at a cap of one, is refused by the
    // cadence — counting the touch just written. A path that wrote its message
    // past the gate would send it.
    const next = (await one("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 2, 'email', 'A second line.') returning id", [experimentId])).id;
    await draftAndApprove(experimentId, next);
    const again = await send(experimentId);
    assert.deepEqual(again.drafts.map((d) => [d.outcome, "detail" in d ? d.detail : []]), [["refused", ["cadence: 1 unsolicited contacts with this person in 30 days, at a cap of 1"]]]);
    assert.equal(world.handed.length, 1, "the second step was handed over past the cap");
  });

  it("is held by the message's gate: past the cap, nothing is written and nothing is handed over", async () => {
    // The cap is the one rule only the message's gate has; the draft's gate
    // has none. Everything else here is what the test above sends.
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    const drafted = await draftAndApprove(experimentId, templateId);
    await aSequencerSend(personId);

    const r = await send(experimentId);
    const line = r.drafts[0] as { outcome: string; detail: string[] };
    assert.equal(line.outcome, "refused");
    assert.deepEqual(line.detail, ["cadence: 1 unsolicited contacts with this person in 30 days, at a cap of 1"]);
    assert.deepEqual(world.handed, [], "the send went through past the cap");
    assert.deepEqual(await counts(), { messages: 0, touches: 0 });
    // Not yet, rather than never: the draft waits, approved.
    assert.equal((await one("select state from acquisition.draft where id = $1", [drafted.drafted[0]!.draftId])).state, "approved");
  });

  it("reads consent when it sends, never from the list: who opted out after the list was made is not sent", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    await draftAndApprove(experimentId, templateId);
    await client.query("update relations.person set opted_out_at = now() where id = $1", [personId]);

    const r = await send(experimentId);
    const line = r.drafts[0] as { outcome: string; detail: string[] };
    assert.equal(line.outcome, "refused");
    assert.deepEqual(line.detail, ["consent: the person opted out"]);
    assert.deepEqual(world.handed, []);
    assert.deepEqual(await counts(), { messages: 0, touches: 0 });
  });

  it("reads protection when it sends: a member whose company became protected after the list was made is dropped, not sent", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    const drafted = await draftAndApprove(experimentId, templateId);
    world.protected = [{ domain: "example.com", reason: "customer" }];

    const r = await send(experimentId);
    assert.equal(r.drafts[0]!.outcome, "protected");
    assert.deepEqual(world.handed, []);
    assert.deepEqual(await counts(), { messages: 0, touches: 0 });
    const d = await one("select state, decided_by, drop_reason from acquisition.draft where id = $1", [drafted.drafted[0]!.draftId]);
    assert.deepEqual(d, { state: "dropped", decided_by: "system", drop_reason: "protected at sending" });
  });

  it("stops before writing anything when protection is stale", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    await draftAndApprove(experimentId, templateId);
    world.protectedAsOf = () => new Date(Date.now() - 120 * 60_000).toISOString();

    const r = await send(experimentId);
    assert.equal(r.status, "failed");
    assert.match(r.stoppedBy!, /older than the 60 allowed/);
    assert.deepEqual(r.drafts, []);
    assert.deepEqual(world.handed, []);
    assert.deepEqual(await counts(), { messages: 0, touches: 0 });
    assert.equal((await one("select status from core.run where id = $1", [r.runId])).status, "failed");
  });

  it("resumes a hand-over that was interrupted, and sends nothing twice", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    await draftAndApprove(experimentId, templateId);

    world.fail = "retryable";
    const first = await send(experimentId);
    assert.equal(first.status, "failed");
    // The message is written and no touch confirms it: the cap still counts it.
    assert.deepEqual(await counts(), { messages: 1, touches: 0 });
    assert.equal((await one("select state from acquisition.draft")).state, "queued");

    const second = await send(experimentId);
    assert.deepEqual(second.drafts.map((d) => d.outcome), ["sent"]);
    const third = await send(experimentId);
    assert.deepEqual(third.drafts, [], "a sent draft is sent again");
    assert.equal(world.handed.length, 1);
    assert.deepEqual(await counts(), { messages: 1, touches: 1 });
  });

  it("keeps why a hand-over failed, on the draft", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    await draftAndApprove(experimentId, templateId);
    world.fail = "refused";

    const r = await send(experimentId);
    assert.equal(r.drafts[0]!.outcome, "failed");
    assert.deepEqual(await one("select state, failure_reason from acquisition.draft"), { state: "failed", failure_reason: "invalid: the stub refuses this address" });
    // The schema holds it too: a failed draft says why, whoever writes it.
    await client.query("insert into acquisition.draft (experiment_id, person_id, step, state, rendered_body, decided_by, decided_at) select experiment_id, person_id, 2, 'approved', 'b', 'x', now() from acquisition.draft");
    await client.query("update acquisition.draft set state = 'queued' where step = 2");
    await assert.rejects(client.query("update acquisition.draft set state = 'failed' where step = 2"), /draft_failed_has_reason/);
  });

  it("writes nothing on a dry run but its run", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    const dryDraft = await draftFromList(db, { listKey: "the-list", experimentId, templateId, compose, gate: { autonomyAfter: 5 }, dryRun: true, trigger: "cli", actor: agent });
    assert.deepEqual(dryDraft.drafted.map((d) => d.outcome), ["would_propose"]);
    assert.equal((await one("select count(*)::int as n from acquisition.draft")).n, 0);

    await draftAndApprove(experimentId, templateId);
    const r = await send(experimentId, { dryRun: true });
    assert.deepEqual(r.drafts.map((d) => d.outcome), ["would_send"]);
    assert.deepEqual(world.handed, []);
    assert.deepEqual(await counts(), { messages: 0, touches: 0 });
    assert.equal((await one("select state from acquisition.draft")).state, "approved");
    assert.equal((await one("select dry_run from core.run where id = $1", [r.runId])).dry_run, true);
  });

  it("drafts for the people on a list, and names a company on it as nobody to write to", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const companyId = (await one("insert into relations.company (name, domain) values ('Other', 'example.org') returning id")).id;
    const { experimentId, templateId } = await aCampaign([{ personId }, { companyId }]);
    const r = await draftFromList(db, { listKey: "the-list", experimentId, templateId, compose, gate: { autonomyAfter: 5 }, dryRun: false, trigger: "cli", actor: agent });
    assert.deepEqual(r.drafted.map((d) => d.personId), [personId]);
    assert.deepEqual(r.skipped, [{ member: { companyId }, reason: "a company on a list names nobody to write to" }]);
  });

  it("holds one touch per message in the DDL", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    await draftAndApprove(experimentId, templateId);
    await send(experimentId);
    const { id } = await one("select id from relations.message");
    await assert.rejects(
      client.query(
        "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type, message_id) values ($1, 'email', 'outbound', true, 'another', 'another-id', now(), 'system', $2)",
        [personId, id],
      ),
      /touch_message_uidx/,
    );
  });
});

describe("the migration that makes a failed draft say why", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("refuses to be added where a draft already failed without a reason", async () => {
    const name = `kernel_send_failed_${process.pid}`;
    await admin.query(`create database ${name}`);
    const url = new URL(base!);
    url.pathname = `/${name}`;
    const old = new Client({ connectionString: url.toString() });
    await old.connect();
    try {
      const acquisition = migrationsOf("..");
      const at = acquisition.findIndex((m) => m.name.includes("draft_says_why_it_failed"));
      assert.ok(at > 0, "the migration is not found");
      for (const layer of ["../../../core", "../../relations"]) for (const m of migrationsOf(layer)) await old.query(m.sql);
      for (const m of acquisition.slice(0, at)) await old.query(m.sql);
      const p = (await old.query("insert into relations.person (email) values ('ada@example.com') returning id")).rows[0].id;
      const e = (await old.query("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id")).rows[0].id;
      await old.query("insert into acquisition.draft (experiment_id, person_id, step, state, rendered_body, decided_by, decided_at) values ($1, $2, 1, 'approved', 'b', 'x', now())", [e, p]);
      await old.query("update acquisition.draft set state = 'queued'");
      await old.query("update acquisition.draft set state = 'failed'");
      await assert.rejects(old.query(acquisition[at]!.sql), /draft_failed_has_reason/);
    } finally {
      await old.end();
      await admin.query(`drop database if exists ${name} with (force)`);
    }
  });
});

describe("nothing sends for real", () => {
  // Decision 0050: no hand-over ships, and nothing but this path's tests and
  // try-instance calls the path. The next decision — sending for real —
  // changes this test, on purpose.
  const root = join(import.meta.dirname, "../../..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === "node_modules" || f === "dist" || f.startsWith(".")) return [];
      return statSync(p).isDirectory() ? sources(p) : /\.(ts|mjs|js)$/.test(f) && !/\.test\.(ts|mjs)$/.test(f) ? [p] : [];
    });

  it("ships no hand-over, and no command or other code calls the sending path", () => {
    const reach = ["core", "domains", "adapters", "api", "template"]
      .flatMap((d) => sources(join(root, d)))
      .filter((p) => !p.endsWith(join("acquisition", "runtime", "send.ts")))
      .filter((p) => /sendFromList|draftFromList|runtime\/send|HandOver\b/.test(readFileSync(p, "utf8")))
      .map((p) => relative(root, p));
    assert.deepEqual(reach, []);
  });
});
