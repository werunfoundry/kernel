/**
 * Tests for a renamed domain's record of what was applied (decision 0046),
 * against a real database: carried from a former name, never replayed, and
 * refused when two records could both be the true one.
 */

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { validateDomain } from "../manifest/validate.js";
import { carryRecord } from "./migrate.js";
import type { Database } from "./run.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_formerly_${process.pid}`;
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
  if (client) await client.query("drop schema if exists drizzle cascade; create schema drizzle");
});

const record = async (name: string, rows = 3) => {
  await client.query(`create table drizzle.__migrations_${name} (id serial primary key, hash text not null, created_at bigint)`);
  for (let i = 0; i < rows; i++) await client.query(`insert into drizzle.__migrations_${name} (hash, created_at) values ('h${i}', ${i})`);
};
const tables = async () =>
  (await client.query("select table_name from information_schema.tables where table_schema = 'drizzle' order by 1")).rows.map((r) => r.table_name as string);

describe("a renamed domain's record of what was applied", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is carried from its former name, rows and all", async () => {
    await record("oldname");
    assert.equal(await carryRecord(db, "newname", ["oldname"]), "oldname");
    assert.deepEqual(await tables(), ["__migrations_newname"]);
    assert.equal((await client.query("select count(*)::int as n from drizzle.__migrations_newname")).rows[0].n, 3);
  });

  it("changes nothing when there is no former record, or no former name", async () => {
    await record("newname");
    assert.equal(await carryRecord(db, "newname", ["oldname"]), undefined);
    assert.equal(await carryRecord(db, "newname", []), undefined);
    assert.deepEqual(await tables(), ["__migrations_newname"]);
  });

  it("refuses when records exist under the current name and a former one", async () => {
    await record("newname");
    await record("oldname");
    await assert.rejects(carryRecord(db, "newname", ["oldname"]), /both as "newname" and as former "oldname"/);
    assert.deepEqual(await tables(), ["__migrations_newname", "__migrations_oldname"]);
  });

  it("refuses when records exist under two former names", async () => {
    await record("first");
    await record("second");
    await assert.rejects(carryRecord(db, "newname", ["first", "second"]), /two former names/);
    assert.deepEqual(await tables(), ["__migrations_first", "__migrations_second"]);
  });
});

describe("formerly, as a domain declares it", () => {
  const base = { name: "newname", version: "0.0.0", description: "d", schema: "newname", dependsOn: [] };
  it("accepts former names", () => {
    assert.deepEqual(validateDomain({ ...base, formerly: ["oldname"] }).issues.filter((i) => i.severity === "error"), []);
  });
  it("refuses its current name as a former one, and a name listed twice", () => {
    assert.ok(validateDomain({ ...base, formerly: ["newname"] }).issues.some((i) => /current name/.test(i.message)));
    assert.ok(validateDomain({ ...base, formerly: ["oldname", "oldname"] }).issues.some((i) => /listed twice/.test(i.message)));
  });
});
