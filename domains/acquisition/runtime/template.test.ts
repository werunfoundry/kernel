/**
 * The migration that renames the addressing domain's `message` to `template`
 * (decision 0038): nothing wrote it, so it is replaced rather than converted —
 * and on a database where something did, it stops rather than drop it.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_template_${process.pid}`;
let admin: Client | undefined;
let old: Client | undefined;

const migrationsOf = (layer: string) => {
  const dir = join(import.meta.dirname, layer, "db/migrations");
  return readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));
};

after(async () => {
  await old?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

describe("the migration that makes message a template", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("refuses to drop a template or a draft's reference something wrote, and goes through once there is none", async () => {
    admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(base!);
    url.pathname = `/${database}`;
    old = new Client({ connectionString: url.toString() });
    await old.connect();

    const acquisition = migrationsOf("..");
    const at = acquisition.findIndex((m) => m.name.includes("message_becomes_template"));
    assert.ok(at > 0, "the migration is not found");
    for (const layer of ["../../../core", "../../relations"]) for (const m of migrationsOf(layer)) await old.query(m.sql);
    for (const m of acquisition.slice(0, at)) await old.query(m.sql);

    const [{ id: experimentId }] = (await old.query("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id")).rows;
    // Before 0046, the schema was called gtm: this is the database as it was.
    await old.query("insert into gtm.message (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello')", [experimentId]);
    await assert.rejects(old.query(acquisition[at]!.sql), /not dropped silently/);

    await old.query("delete from gtm.message");
    for (const m of acquisition.slice(at)) await old.query(m.sql);
    assert.equal((await old.query("select count(*)::int as n from acquisition.template")).rows[0].n, 0);
  });
});
