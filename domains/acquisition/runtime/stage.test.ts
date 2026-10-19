/**
 * Tests for a declared stage of the addressing motion (decision 0036),
 * against a real database: a person's act, kept as a history, read through
 * the view this domain publishes; and a migration that refuses to drop state
 * something wrote before it.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import { declareStage, readStage } from "./stage.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_stage_${process.pid}`;
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

beforeEach(async () => {
  if (client) await client.query("truncate acquisition.person_state, acquisition.company_state, relations.person, relations.company, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aPerson = async () => (await rows("insert into relations.person (email) values ('ada@example.com') returning id"))[0].id as string;
const aCompany = async () => (await rows("insert into relations.company (name, domain) values ('Example', 'example.com') returning id"))[0].id as string;

describe("a declared stage", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is a person's act, recorded as its own run, and read through the published view", async () => {
    const personId = await aPerson();
    const r = await declareStage(db, { trigger: "cli", subject: { personId }, stage: "opportunity", at: new Date("2026-09-01T00:00:00Z"), reason: "meeting held", by: "an operator" });
    assert.equal(r.declared, true);
    const run = (await rows("select process_key, actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0];
    assert.deepEqual(run, { process_key: "acquisition.stage.declare", actor_type: "human", actor_id: "an operator", status: "succeeded" });
    assert.equal((await rows("select trigger from core.run where id = $1", [r.runId]))[0].trigger, "cli", "the run keeps the channel its caller gave (0048)");
    assert.deepEqual(await readStage(db, { personId }), { stage: "opportunity", at: new Date("2026-09-01T00:00:00Z"), reason: "meeting held", declaredBy: "an operator" });
  });

  it("keeps the history; the current stage is the latest by when it became true", async () => {
    const companyId = await aCompany();
    await declareStage(db, { trigger: "cli", subject: { companyId }, stage: "engaged", at: new Date("2026-09-10T00:00:00Z"), by: "an operator" });
    await declareStage(db, { trigger: "cli", subject: { companyId }, stage: "targeted", at: new Date("2026-08-01T00:00:00Z"), by: "an operator" });
    assert.equal((await readStage(db, { companyId }))?.stage, "engaged");
    assert.equal((await rows("select count(*)::int as n from acquisition.company_state"))[0].n, 2);
    assert.equal(await readStage(db, { personId: await aPerson() }), undefined);
  });

  it("keeps one row when the same declaration is replayed", async () => {
    const personId = await aPerson();
    const at = new Date("2026-09-01T00:00:00Z");
    await declareStage(db, { trigger: "cli", subject: { personId }, stage: "engaged", at, by: "an operator" });
    assert.equal((await declareStage(db, { trigger: "cli", subject: { personId }, stage: "engaged", at, by: "an operator" })).declared, false);
    assert.equal((await rows("select count(*)::int as n from acquisition.person_state"))[0].n, 1);
  });

  it("is a person's in the schema, for a person and for a company", async () => {
    const [personId, companyId] = [await aPerson(), await aCompany()];
    const [{ id: runId }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'manual', 'agent') returning id");
    for (const [table, column, id] of [["person_state", "person_id", personId], ["company_state", "company_id", companyId]]) {
      const insert = (actor: string) => client.query(`insert into acquisition.${table} (${column}, stage, at, actor_type, actor_id, run_id) values ($1, 'engaged', now(), $2, 'x', $3)`, [id, actor, runId]);
      await assert.rejects(insert("agent"), new RegExp(`${table}_human_check`));
      await insert("human");
    }
  });

  it("is append-only in the schema, for a person and for a company", async () => {
    await declareStage(db, { trigger: "cli", subject: { personId: await aPerson() }, stage: "engaged", at: new Date("2026-09-01"), by: "an operator" });
    await declareStage(db, { trigger: "cli", subject: { companyId: await aCompany() }, stage: "engaged", at: new Date("2026-09-01"), by: "an operator" });
    await assert.rejects(client.query("update acquisition.person_state set stage = 'opportunity'"), /acquisition\.person_state is append-only/);
    await assert.rejects(client.query("update acquisition.company_state set reason = 'edited'"), /acquisition\.company_state is append-only/);
  });

  it("has no customer, no lost and no unknown: those are not stages of the motion", async () => {
    const personId = await aPerson();
    const [{ id: runId }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'manual', 'human') returning id");
    for (const stage of ["customer", "lost", "unknown"]) {
      await assert.rejects(
        client.query("insert into acquisition.person_state (person_id, stage, at, actor_type, actor_id, run_id) values ($1, $2, now(), 'human', 'x', $3)", [personId, stage, runId]),
        /invalid input value for enum/,
      );
    }
  });
});

describe("the migration that replaces the one-row state tables", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const name = `${database}_old`;
  let old: Client;

  after(async () => {
    await old?.end();
    await admin?.query(`drop database if exists ${name} with (force)`);
  });

  it("refuses to drop a state something wrote, and goes through once there is none", async () => {
    old = await connect(name);
    const acquisition = migrationsOf("..");
    const at = acquisition.findIndex((m) => m.name.includes("stages_leave_customer"));
    assert.ok(at > 0, "the migration that replaces the state tables is not found");
    for (const layer of ["../../../core", "../../relations"]) for (const m of migrationsOf(layer)) await old.query(m.sql);
    for (const m of acquisition.slice(0, at)) await old.query(m.sql);

    // Before 0046, the schema was called gtm: this is the database as it was.
    await old.query("insert into relations.person (email) values ('ada@example.com')");
    await old.query("insert into gtm.person_state (person_id, lifecycle_stage) select id, 'customer' from relations.person");
    await assert.rejects(old.query(acquisition[at]!.sql), /not dropped silently/);
    assert.equal((await old.query("select count(*)::int as n from gtm.person_state")).rows[0].n, 1);

    await old.query("delete from gtm.person_state");
    for (const m of acquisition.slice(at)) await old.query(m.sql);
    assert.equal((await old.query("select count(*)::int as n from acquisition.person_state_current")).rows[0].n, 0);
  });
});
