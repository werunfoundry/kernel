/**
 * Tests for the event and the decision as the core keeps them (decision
 * 0039), against a real database: appended and never rewritten, an event of
 * a declared type stored once, a decision a person's.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { recordDecision } from "./decision.js";
import { recordEvent } from "./event.js";
import type { Database } from "./run.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_work_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

const migrations = () => {
  const dir = join(import.meta.dirname, "../db/migrations");
  return readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));
};

async function connect(name: string): Promise<Client> {
  await admin.query(`create database ${name}`);
  const url = new URL(base!);
  url.pathname = `/${name}`;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  return c;
}

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  client = await connect(database);
  for (const m of migrations()) await client.query(m.sql);
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
  if (client) await client.query("truncate core.event, core.decision, core.experiment, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aRun = async (actor = "system") => (await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', $1) returning id", [actor]))[0].id as string;
const anExperiment = async () => (await rows("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id"))[0].id as string;
const declared = new Set(["acquisition.reply"]);

describe("an event", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const input = (runId: string, over = {}) => ({ kind: "acquisition.reply", provider: "memory", providerEventId: "e1", occurredAt: new Date("2026-09-01T10:00:00Z"), payload: { a: 1 }, runId, ...over });

  it("is stored once, however often it is read", async () => {
    const runId = await aRun();
    assert.equal((await recordEvent(db, input(runId), declared)).recorded, true);
    assert.deepEqual(await recordEvent(db, input(runId), declared), { recorded: false });
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 1);
  });

  it("is refused when no enabled domain declares its type", async () => {
    await assert.rejects(recordEvent(db, input(await aRun(), { kind: "acquisition.unknown" }), declared), /no enabled domain declares/);
  });

  it("is append-only in the schema: never marked handled in place", async () => {
    await recordEvent(db, input(await aRun()), declared);
    await assert.rejects(client.query("update core.event set payload = '{}'::jsonb"), /core\.event is append-only/);
  });

  it("keeps the run that read it: that run is not deleted from under it", async () => {
    const runId = await aRun();
    await recordEvent(db, input(runId), declared);
    await assert.rejects(client.query("delete from core.run where id = $1", [runId]), /foreign key/);
  });
});

describe("a decision", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const readings = [{ metric: "acquisition.replied", value: 0.04, readAt: "2026-09-30T00:00:00Z" }];

  it("is a person's act, in its own run, with the readings it rested on", async () => {
    const experimentId = await anExperiment();
    const r = await recordDecision(db, { experimentId, conclusion: "killed: below the threshold", readings, by: "an operator" });
    assert.deepEqual((await rows("select process_key, actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0], {
      process_key: "core.decision.record",
      actor_type: "human",
      actor_id: "an operator",
      status: "succeeded",
    });
    assert.deepEqual((await rows("select conclusion, readings from core.decision"))[0], { conclusion: "killed: below the threshold", readings });
  });

  it("is a person's in the schema: an agent's is refused, everything else being valid", async () => {
    const [experimentId, runId] = [await anExperiment(), await aRun("agent")];
    const insert = (actor: string) =>
      client.query("insert into core.decision (experiment_id, conclusion, readings, actor_type, actor_id, run_id) values ($1, 'x', '[]', $2, 'x', $3)", [experimentId, actor, runId]);
    await assert.rejects(insert("agent"), /decision_human_check/);
    await insert("human");
  });

  it("keeps its readings as a list", async () => {
    const [experimentId, runId] = [await anExperiment(), await aRun("human")];
    await assert.rejects(
      client.query("insert into core.decision (experiment_id, conclusion, readings, actor_type, actor_id, run_id) values ($1, 'x', '{}', 'human', 'x', $2)", [experimentId, runId]),
      /decision_readings_check/,
    );
  });

  it("is append-only, and its experiment is not deleted from under it", async () => {
    const experimentId = await anExperiment();
    await recordDecision(db, { experimentId, conclusion: "validated", readings: [], by: "an operator" });
    await assert.rejects(client.query("update core.decision set conclusion = 'killed'"), /core\.decision is append-only/);
    await assert.rejects(client.query("delete from core.experiment where id = $1", [experimentId]), /foreign key/);
  });
});

describe("the migration that narrows event and decision", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const name = `${database}_old`;
  let old: Client;

  after(async () => {
    await old?.end();
    await admin?.query(`drop database if exists ${name} with (force)`);
  });

  it("refuses to drop an event something wrote, and goes through once there is none", async () => {
    old = await connect(name);
    const all = migrations();
    const at = all.findIndex((m) => m.name.startsWith("0001_"));
    for (const m of all.slice(0, at)) await old.query(m.sql);
    await old.query("insert into core.event (kind, provider, provider_event_id, payload) values ('acquisition.reply', 'memory', 'e1', '{}')");
    await assert.rejects(old.query(all[at]!.sql), /not dropped silently/);
    await old.query("delete from core.event");
    for (const m of all.slice(at)) await old.query(m.sql);
    assert.equal((await old.query("select count(*)::int as n from core.decision")).rows[0].n, 0);
  });
});
