/**
 * Tests for drafting from a frozen list (decision 0050's run 1), against a
 * real database. The run that handed each message over is withdrawn (0064
 * §1): the enrolment from a list carries the approved drafts, and its tests
 * are `enrol-from-list.test.ts`.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import { fingerprinter, fingerprintOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Database } from "@werunfoundry/core/runtime/run";
import { constituteList } from "@werunfoundry/relations/runtime/list";
import { writeMessage } from "@werunfoundry/relations/runtime/message";

import { draftFromList, messageKey } from "./send.js";

/** The register's reader, under one version whose secret is held (0055). */
const SECRET = generateSecret();
const vocabulary = identityVocabulary([loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!]);
const register = fingerprinter("T1", { T1: SECRET }, [], vocabulary);

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


/* Fixtures ------------------------------------------------------------------ */

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

beforeEach(async () => {
  if (!client) return;
  await client.query("truncate relations.touch, relations.message, relations.list, relations.person, relations.company, acquisition.draft, acquisition.template, core.experiment, core.run cascade");
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

/* -------------------------------------------------------------------------- */

describe("drafting from a list", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("drafts for the people on a list, and names a company on it as nobody to write to", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const companyId = (await one("insert into relations.company (name, domain) values ('Other', 'example.org') returning id")).id;
    const { experimentId, templateId } = await aCampaign([{ personId }, { companyId }]);
    const r = await draftFromList(db, register, { listKey: "the-list", experimentId, templateId, compose, gate: { autonomyAfter: 5 }, dryRun: false, trigger: "cli", actor: agent });
    assert.deepEqual(r.drafted.map((d) => d.personId), [personId]);
    assert.deepEqual(r.skipped, [{ member: { companyId }, reason: "a company on a list names nobody to write to" }]);
  });

  it("writes nothing on a dry run but its run", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId }]);
    const r = await draftFromList(db, register, { listKey: "the-list", experimentId, templateId, compose, gate: { autonomyAfter: 5 }, dryRun: true, trigger: "cli", actor: agent });
    assert.deepEqual(r.drafted, [{ personId, outcome: "would_propose" }]);
    assert.equal((await one("select count(*)::int as n from acquisition.draft")).n, 0);
  });

  // What a composer is handed, recorded: an objector's address must never be in it.
  const handed: unknown[] = [];
  const watching = (p: unknown, t: { subject?: string; body: string }) => {
    handed.push(p);
    return compose(p, t);
  };
  const draftWatched = (experimentId: string, templateId: string, dryRun: boolean, fingerprints = register) =>
    draftFromList(db, fingerprints, { listKey: "the-list", experimentId, templateId, compose: watching, gate: { autonomyAfter: 5 }, dryRun, trigger: "cli", actor: agent });

  it("hands nothing of a person who opted out to the composer, live or dry, and drafts nothing for them", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const bo = await aPerson("bo@example.com", "example.com");
    await client.query("update relations.person set opted_out_at = now() where id = $1", [ada]);
    const { experimentId, templateId } = await aCampaign([{ personId: ada }, { personId: bo }]);
    for (const dryRun of [true, false]) {
      handed.length = 0;
      const r = await draftWatched(experimentId, templateId, dryRun);
      assert.deepEqual(handed.map((p) => (p as { email?: string }).email), ["bo@example.com"], "the composer was handed an objector");
      assert.deepEqual(r.skipped, [{ member: { personId: ada }, reason: "the person opted out: nothing of them is handed to the composer, and nothing is drafted" }]);
    }
    assert.deepEqual((await rows("select person_id from acquisition.draft")).map((d) => d.person_id), [bo]);
  });

  it("hands nothing to the composer of a person the register holds an objection for", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    await client.query("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T1}', now())", [fingerprintOf(SECRET, { kind: "email", value: "ada@example.com" }, vocabulary)]);
    try {
      const { experimentId, templateId } = await aCampaign([{ personId: ada }]);
      handed.length = 0;
      const r = await draftWatched(experimentId, templateId, false);
      assert.deepEqual(handed, []);
      assert.equal(r.skipped.length, 1);
    } finally {
      await client.query("set session_replication_role = replica; truncate relations.suppression; set session_replication_role = origin");
    }
  });

  it("stops, handing nobody to the composer, while the register cannot be read", async () => {
    const ada = await aPerson("ada@example.com", "example.com");
    const { experimentId, templateId } = await aCampaign([{ personId: ada }]);
    handed.length = 0;
    await assert.rejects(draftWatched(experimentId, templateId, false, fingerprinter("T1", { T1: SECRET }, ["T0"], vocabulary)), /the objection cannot be read/);
    assert.deepEqual(handed, []);
  });

  it("holds one touch per message in the DDL", async () => {
    const personId = await aPerson("ada@example.com", "example.com");
    const written = await writeMessage(db, register, { key: messageKey("00000000-0000-4000-8000-000000000000"), personId, channel: "email", body: "Hello", unsolicited: false, actor: { type: "human", id: "an operator" } });
    assert.ok(written.ok);
    const touch = (event: string) =>
      client.query(
        "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type, message_id) values ($1, 'email', 'outbound', true, 'a-sequencer', $2, now(), 'system', $3)",
        [personId, event, written.messageId],
      );
    await touch("first");
    await assert.rejects(touch("second"), /touch_message_uidx/);
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

describe("no hand-over is left (0064 §1)", () => {
  // Decision 0064 withdrew the hand-over: one verb reaches a person,
  // `enrol`. Nothing in the kernel names the hand-over or its run again.
  const root = join(import.meta.dirname, "../../..");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (f === "node_modules" || f === "dist" || f.startsWith(".")) return [];
      return statSync(p).isDirectory() ? sources(p) : /\.(ts|mjs|js)$/.test(f) ? [p] : [];
    });

  it("is named by no code, test or script", () => {
    const reach = ["core", "domains", "adapters", "api", "template", "scripts"]
      .flatMap((d) => sources(join(root, d)))
      .filter((p) => !p.endsWith(join("acquisition", "runtime", "send.test.ts")))
      .filter((p) => /sendFromList|HandOver\b|handOver\(/.test(readFileSync(p, "utf8")))
      .map((p) => relative(root, p));
    assert.deepEqual(reach, []);
  });
});
