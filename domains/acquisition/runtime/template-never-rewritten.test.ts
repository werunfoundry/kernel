/**
 * Decision 0072 in the DDL: a template is never rewritten; one no draft cites
 * may be withdrawn and recorded again; a correction carries its mark on
 * every step and names an arm of its experiment, never another correction.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_template_0072_${process.pid}`;
let admin: Client | undefined;
let client: Client;
let experimentId: string;

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const template = (variant: string, step: number, corrects: string | null = null) =>
  rows("insert into acquisition.template (experiment_id, variant, step, channel, body, corrects) values ($1, $2, $3, 'email', 'Hello', $4) returning id", [
    experimentId,
    variant,
    step,
    corrects,
  ]).then((r) => r[0].id as string);

describe("a template is never rewritten (decision 0072)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  before(async () => {
    admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(base!);
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    for (const layer of ["../../../core", "../../relations", ".."]) {
      const dir = join(import.meta.dirname, layer, "db/migrations");
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(dir, f), "utf8"));
    }
  });

  after(async () => {
    await client?.end();
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await client.query("truncate core.experiment, relations.person cascade");
    [{ id: experimentId }] = await rows("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id");
  });

  const draftOf = async (templateId: string) => {
    const [{ id: personId }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    await rows("insert into acquisition.draft (experiment_id, person_id, template_id, step, rendered_body) values ($1, $2, $3, 1, 'Hello Ada')", [experimentId, personId, templateId]);
  };

  it("refuses any update, of its text or of its mark", async () => {
    const id = await template("a", 1);
    await assert.rejects(rows("update acquisition.template set body = 'Hi' where id = $1", [id]), /never rewritten/);
    await assert.rejects(rows("update acquisition.template set corrects = 'x' where id = $1", [id]), /never rewritten/);
    assert.deepEqual(await rows("select body, corrects from acquisition.template"), [{ body: "Hello", corrects: null }]);
  });

  it("lets a template no draft cites be withdrawn and recorded again at its step", async () => {
    const id = await template("a", 1);
    await rows("delete from acquisition.template where id = $1", [id]);
    await template("a", 1);
    assert.equal((await rows("select count(*)::int as n from acquisition.template"))[0].n, 1);
  });

  it("refuses to delete a template a draft cites, and still lets its experiment go with both", async () => {
    const id = await template("a", 1);
    await draftOf(id);
    await assert.rejects(rows("delete from acquisition.template where id = $1", [id]), /violates foreign key constraint/);
    await rows("delete from core.experiment where id = $1", [experimentId]);
    assert.deepEqual(await rows("select (select count(*)::int from acquisition.template) as t, (select count(*)::int from acquisition.draft) as d"), [{ t: 0, d: 0 }]);
  });

  it("records a correction of an arm, the same mark on every step", async () => {
    await template("a", 1);
    await template("a", 2);
    await template("b", 1, "a");
    await template("b", 2, "a");
    // A second correction of the same arm names that arm too.
    await template("c", 1, "a");
    assert.deepEqual(await rows("select variant, corrects from acquisition.template order by variant, step"), [
      { variant: "a", corrects: null },
      { variant: "a", corrects: null },
      { variant: "b", corrects: "a" },
      { variant: "b", corrects: "a" },
      { variant: "c", corrects: "a" },
    ]);
  });

  it("refuses a step whose mark differs from its variant's, either way", async () => {
    await template("a", 1);
    await template("b", 1, "a");
    await assert.rejects(template("b", 2), /carries the same mark/);
    await assert.rejects(template("a", 2, "b"), /carries the same mark/);
  });

  it("refuses a correction that names a correction, itself, or no arm of the experiment", async () => {
    await template("a", 1);
    await template("b", 1, "a");
    await assert.rejects(template("c", 1, "b"), /names an arm of its experiment, and "b" is none/);
    await assert.rejects(template("d", 1, "d"), /"d" is none/);
    await assert.rejects(template("e", 1, "z"), /"z" is none/);
  });
});
