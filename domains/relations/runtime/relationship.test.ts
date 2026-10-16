/**
 * Tests for a declared relationship and a touch that says whether it was
 * solicited (decision 0036), against a real database: what they rest on is in
 * the DDL — the checks that refuse an actor who is not a person and an
 * inbound touch called unsolicited, the trigger that keeps declarations
 * append-only, the view that reads the current one, and the backfill that
 * gives existing touches a side.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import { declareRelationship, readRelationship } from "./relationship.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_relationship_${process.pid}`;
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
  for (const layer of ["../../../core", ".."]) for (const m of migrationsOf(layer)) await client.query(m.sql);
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
  if (client) await client.query("truncate relations.relationship, relations.touch, relations.person, relations.company, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aCompany = async () => (await rows("insert into relations.company (name, domain) values ('Example', 'example.com') returning id"))[0].id as string;
const aPerson = async () => (await rows("insert into relations.person (email) values ('ada@example.com') returning id"))[0].id as string;
const aRun = async (actor = "human") => (await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'manual', $1) returning id", [actor]))[0].id as string;

describe("a declared relationship", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is a person's act, recorded as its own run with them as actor, and read through the view", async () => {
    const companyId = await aCompany();
    const r = await declareRelationship(db, { subject: { companyId }, status: "customer", at: new Date("2026-09-01T00:00:00Z"), reason: "signed", by: "an operator" });
    assert.equal(r.declared, true);
    const run = (await rows("select process_key, actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0];
    assert.deepEqual(run, { process_key: "relations.relationship.declare", actor_type: "human", actor_id: "an operator", status: "succeeded" });
    assert.deepEqual(await readRelationship(db, { companyId }), { status: "customer", at: new Date("2026-09-01T00:00:00Z"), reason: "signed", declaredBy: "an operator" });
  });

  it("keeps the history, and the current one is the latest by when it became true, not by when it was written", async () => {
    const personId = await aPerson();
    await declareRelationship(db, { subject: { personId }, status: "former_customer", at: new Date("2026-09-10T00:00:00Z"), by: "an operator" });
    // Written after, true before: it is history, not the present.
    await declareRelationship(db, { subject: { personId }, status: "customer", at: new Date("2026-08-01T00:00:00Z"), by: "an operator" });
    assert.equal((await readRelationship(db, { personId }))?.status, "former_customer");
    assert.equal((await rows("select count(*)::int as n from relations.relationship"))[0].n, 2);
  });

  it("has no current relationship for a subject nobody declared one for", async () => {
    assert.equal(await readRelationship(db, { companyId: await aCompany() }), undefined);
  });

  it("keeps one row when the same declaration is replayed", async () => {
    const companyId = await aCompany();
    const at = new Date("2026-09-01T00:00:00Z");
    await declareRelationship(db, { subject: { companyId }, status: "customer", at, by: "an operator" });
    const again = await declareRelationship(db, { subject: { companyId }, status: "customer", at, by: "another operator" });
    assert.equal(again.declared, false);
    assert.equal((await rows("select count(*)::int as n from relations.relationship"))[0].n, 1);
  });

  it("refuses, before any run, a declaration dated ahead of now or made by nobody", async () => {
    const companyId = await aCompany();
    await assert.rejects(declareRelationship(db, { subject: { companyId }, status: "customer", at: new Date(Date.now() + 86_400_000), by: "an operator" }), /not ahead of it/);
    await assert.rejects(declareRelationship(db, { subject: { companyId }, status: "customer", at: new Date("2026-01-01"), by: "  " }), /a person's/);
    assert.equal((await rows("select count(*)::int as n from core.run"))[0].n, 0);
  });

  it("is a person's in the schema: an agent's declaration is refused, everything else being valid", async () => {
    const companyId = await aCompany();
    const runId = await aRun("agent");
    const insert = (actor: string) =>
      client.query("insert into relations.relationship (company_id, status, at, actor_type, actor_id, run_id) values ($1, 'customer', now(), $2, 'x', $3)", [companyId, actor, runId]);
    await assert.rejects(insert("agent"), /relationship_human_check/);
    await insert("human");
  });

  it("is append-only in the schema: a declaration is corrected by another, never rewritten", async () => {
    const companyId = await aCompany();
    await declareRelationship(db, { subject: { companyId }, status: "customer", at: new Date("2026-09-01T00:00:00Z"), by: "an operator" });
    await assert.rejects(client.query("update relations.relationship set status = 'none'"), /append-only/);
    await assert.rejects(client.query("update relations.relationship set reason = 'edited'"), /append-only/);
  });

  it("names exactly one subject", async () => {
    const [companyId, personId, runId] = [await aCompany(), await aPerson(), await aRun()];
    const insert = (c: string | null, p: string | null) =>
      client.query("insert into relations.relationship (company_id, person_id, status, at, actor_type, actor_id, run_id) values ($1, $2, 'customer', now(), 'human', 'x', $3)", [c, p, runId]);
    await assert.rejects(insert(companyId, personId), /relationship_one_subject/);
    await assert.rejects(insert(null, null), /relationship_one_subject/);
  });
});

describe("a touch says whether it was solicited", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const insert = async (direction: string, unsolicited: boolean | null) =>
    client.query(
      "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', $2, $3, 'memory', gen_random_uuid()::text, now(), 'system')",
      [await aPerson(), direction, unsolicited],
    );

  it("refuses an inbound touch called unsolicited: what the person did is not outreach", async () => {
    await assert.rejects(insert("inbound", true), /touch_inbound_not_unsolicited/);
  });

  it("refuses an outbound touch that does not say", async () => {
    await assert.rejects(insert("outbound", null), /null value in column "unsolicited"/);
  });

  it("takes either side for an outbound touch: a support answer is solicited, a follow-up is not", async () => {
    await client.query("truncate relations.person cascade");
    await insert("outbound", false);
    await client.query("truncate relations.person cascade");
    await insert("outbound", true);
  });
});

describe("the backfill of touches recorded before 0036", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const name = `${database}_backfill`;
  let old: Client;

  after(async () => {
    await old?.end();
    await admin?.query(`drop database if exists ${name} with (force)`);
  });

  it("makes outbound touches unsolicited and inbound ones not, through the append-only trigger, and leaves it on", async () => {
    old = await connect(name);
    const relations = migrationsOf("..");
    const at = relations.findIndex((m) => m.name.startsWith("0003_"));
    assert.ok(at > 0, "the migration that adds the column is not found");
    for (const m of migrationsOf("../../../core")) await old.query(m.sql);
    for (const m of relations.slice(0, at)) await old.query(m.sql);

    const [{ id: personId }] = (await old.query("insert into relations.person (email) values ('ada@example.com') returning id")).rows;
    for (const [direction, id] of [["outbound", "o"], ["inbound", "i"]]) {
      await old.query(
        "insert into relations.touch (person_id, channel, direction, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', $2, 'memory', $3, now(), 'system')",
        [personId, direction, id],
      );
    }
    for (const m of relations.slice(at)) await old.query(m.sql);

    assert.deepEqual((await old.query("select direction, unsolicited from relations.touch order by direction::text")).rows, [
      { direction: "inbound", unsolicited: false },
      { direction: "outbound", unsolicited: true },
    ]);
    await assert.rejects(old.query("update relations.touch set unsolicited = false"), /append-only/);
  });
});
