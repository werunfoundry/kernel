/**
 * Tests for a list (decision 0037), against a real database: what freezes it
 * is in the DDL — the triggers that refuse a member added to a sealed list,
 * a member rewritten, or a list changed after its seal — and erasing a
 * person must still go through.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import { constituteList, readList } from "./list.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_list_${process.pid}`;
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
  if (client) await client.query("truncate relations.list, relations.person, relations.company, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aPerson = async (email: string) => (await rows("insert into relations.person (email) values ($1) returning id", [email]))[0].id as string;
const aRun = async () => (await rows("insert into core.run (process_key, trigger, actor_type) values ('select', 'cli', 'agent') returning id"))[0].id as string;
const query = { stage: "engaged", country: "any" };

async function aSealedList(key = "january") {
  const [ada, bob, runId] = [await aPerson("ada@example.com"), await aPerson("bob@example.com"), await aRun()];
  const made = await constituteList(db, { key, query, members: [{ personId: ada, reason: "matched" }, { personId: bob }], actor: { type: "agent", id: "selector" }, runId });
  return { ...made, ada, bob, runId };
}

describe("a list", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is constituted with its members and its query, and sealed in the same stroke", async () => {
    const { constituted, members, ada } = await aSealedList();
    assert.deepEqual({ constituted, members }, { constituted: true, members: 2 });
    const read = await readList(db, "january");
    assert.ok(read?.sealedAt instanceof Date);
    assert.deepEqual(read.query, query);
    assert.deepEqual(read.members.find((m) => m.personId === ada), { personId: ada, companyId: null, reason: "matched" });
  });

  it("keeps the first list when its key is constituted again: the evidence stands", async () => {
    const first = await aSealedList();
    const again = await constituteList(db, { key: "january", query: { other: true }, members: [{ personId: first.ada }], actor: { type: "agent" }, runId: first.runId });
    assert.deepEqual(again, { listId: first.listId, constituted: false, members: 2 });
    assert.deepEqual((await readList(db, "january"))?.query, query);
  });

  it("keeps a subject given twice once", async () => {
    const [ada, runId] = [await aPerson("ada@example.com"), await aRun()];
    const made = await constituteList(db, { key: "twice", query, members: [{ personId: ada }, { personId: ada }], actor: { type: "agent" }, runId });
    assert.equal(made.members, 1);
  });

  it("gains no member once sealed, in the schema", async () => {
    const { listId } = await aSealedList();
    const carol = await aPerson("carol@example.com");
    await assert.rejects(client.query("insert into relations.list_member (list_id, person_id) values ($1, $2)", [listId, carol]), /list_member is frozen/);
  });

  it("never rewrites a member, in the schema", async () => {
    await aSealedList();
    await assert.rejects(client.query("update relations.list_member set reason = 'edited'"), /list_member is frozen/);
  });

  it("is sealed once and then never changed, in the schema", async () => {
    await aSealedList();
    await assert.rejects(client.query("update relations.list set query = '{}'::jsonb"), /list is frozen/);
    await assert.rejects(client.query("update relations.list set sealed_at = now() + interval '1 day'"), /list is frozen/);
  });

  it("lets a person be erased though they were selected", async () => {
    const { ada } = await aSealedList();
    await client.query("delete from relations.person where id = $1", [ada]);
    assert.equal((await readList(db, "january"))?.members.length, 1);
  });

  it("names exactly one subject per member", async () => {
    const runId = await aRun();
    const [{ id: listId }] = await rows("insert into relations.list (key, query, actor_type, run_id) values ('open', '{}', 'agent', $1) returning id", [runId]);
    await assert.rejects(client.query("insert into relations.list_member (list_id) values ($1)", [listId]), /list_member_one_subject/);
  });
});

describe("the migration that replaces audience", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const name = `${database}_old`;
  let old: Client;

  after(async () => {
    await old?.end();
    await admin?.query(`drop database if exists ${name} with (force)`);
  });

  it("refuses to drop an audience something wrote, and goes through once there is none", async () => {
    old = await connect(name);
    const relations = migrationsOf("..");
    // By name, not number: a migration's number is wherever it landed.
    const at = relations.findIndex((m) => m.name.includes("audience_becomes_list"));
    assert.ok(at > 0, "the migration that replaces audience is not found");
    for (const m of migrationsOf("../../../core")) await old.query(m.sql);
    for (const m of relations.slice(0, at)) await old.query(m.sql);

    await old.query("insert into relations.audience (key, kind) values ('exclude:protected', 'exclude')");
    await assert.rejects(old.query(relations[at]!.sql), /not dropped silently/);
    assert.equal((await old.query("select count(*)::int as n from relations.audience")).rows[0].n, 1);

    await old.query("delete from relations.audience");
    for (const m of relations.slice(at)) await old.query(m.sql);
    assert.equal((await old.query("select count(*)::int as n from relations.list")).rows[0].n, 0);
  });
});
