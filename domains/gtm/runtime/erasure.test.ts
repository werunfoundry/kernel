/**
 * Erasure as the domains declare it and the core carries it out (decision
 * 0040), against a real database with every layer migrated — the only place
 * the declarations of both domains meet the tables they name.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { DomainManifest } from "@werunfoundry/core/manifest/types";
import { validateDomain } from "@werunfoundry/core/manifest/validate";
import { erase, planErasure } from "@werunfoundry/core/runtime/erase";
import type { Database } from "@werunfoundry/core/runtime/run";
import * as relationsSchema from "@werunfoundry/relations/db/schema";

import * as gtmSchema from "../db/schema.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_erasure_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

const relations = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!;
const gtm = loadDomain(join(import.meta.dirname, "../domain.yaml")).manifest!;

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

beforeEach(async () => {
  if (client) await client.query("truncate relations.person, relations.company, relations.audience, core.experiment, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

/** A person named by a row in every table that can name one. */
async function someone(): Promise<string> {
  const [{ id }] = await rows("insert into relations.person (email, full_name) values ('ada@example.com', 'Ada') returning id");
  const [{ id: e }] = await rows("insert into core.experiment (slug, type, hypothesis_ref) values ('e', 'campaign', 'https://example.com/h') returning id");
  const [{ id: run }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', 'system') returning id");
  const [{ id: a }] = await rows("insert into relations.audience (key, kind) values ('a', 'include') returning id");
  await client.query("insert into relations.audience_member (audience_id, person_id, source) values ($1, $2, 'test')", [a, id]);
  await client.query("insert into relations.touch (person_id, channel, direction, sender, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', 'a mailbox', 'memory', 't1', now(), 'system')", [id]);
  await client.query("insert into relations.signal (person_id, kind, source, content_hash, occurred_at) values ($1, 'k', 's', 'h', now())", [id]);
  await client.query("insert into gtm.draft (experiment_id, person_id, step, rendered_body) values ($1, $2, 1, 'Hello')", [e, id]);
  await client.query("insert into gtm.person_state (person_id) values ($1)", [id]);
  await client.query("insert into gtm.enrolment (person_id, sequence_key, channel, idempotency_key, provider, actor_type) values ($1, 's', 'email', 'k', 'memory', 'system')", [id]);
  await client.query("insert into gtm.sourcing_result (run_id, pass, outcome, detail, company, person_id, subject) values ($1, 'person', 'kept', 'd', '{}', $2, 's')", [run, id]);
  return id;
}

const total = async (personId: string) =>
  (await rows(
    `select (select count(*) from relations.audience_member where person_id = $1) + (select count(*) from relations.touch where person_id = $1)
      + (select count(*) from relations.signal where person_id = $1) + (select count(*) from gtm.draft where person_id = $1)
      + (select count(*) from gtm.person_state where person_id = $1) + (select count(*) from gtm.enrolment where person_id = $1)
      + (select count(*) from gtm.sourcing_result where person_id = $1) as n`,
    [personId],
  ))[0].n as string;

describe("erasure, as declared", () => {
  it("has an answer for every table that names a person, in every domain", () => {
    for (const [domain, schema] of [[relations, relationsSchema], [gtm, gtmSchema]] as const) {
      const declared = new Set((domain.erasure ?? []).map((r) => `${r.table}.${r.column}`));
      for (const value of Object.values(schema)) {
        if (!(value instanceof PgTable)) continue;
        const config = getTableConfig(value);
        for (const fk of config.foreignKeys) {
          const ref = fk.reference();
          if (getTableConfig(ref.foreignTable).name !== "person" || getTableConfig(ref.foreignTable).schema !== "relations") continue;
          for (const column of ref.columns) assert.ok(declared.has(`${config.name}.${column.name}`), `${domain.name}: ${config.name}.${column.name} names a person and has no erasure rule`);
        }
      }
    }
    assert.ok(relations.erasure?.some((r) => r.table === "person" && r.column === "id"), "the person's own row has no rule");
  });

  it("refuses a row kept with no legal basis", () => {
    const r = validateDomain({ ...relations, erasure: [{ table: "touch", column: "person_id", do: "keep" }] });
    assert.ok(r.issues.some((i) => i.severity === "error" && /erasure/.test(i.at)), JSON.stringify(r.issues));
  });
});

describe("erasing a person", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("shows the plan, upper domains first and the person's own row last, and changes nothing", async () => {
    const id = await someone();
    const plan = await planErasure(db, [relations, gtm], id);
    assert.deepEqual(plan.map((s) => `${s.domain}.${s.table}:${s.rows}`), [
      "gtm.draft:1", "gtm.person_state:1", "gtm.enrolment:1", "gtm.sourcing_result:1",
      "relations.audience_member:1", "relations.touch:1", "relations.signal:1", "relations.person:1",
    ]);
    assert.equal(await total(id), "7");
  });

  it("takes the person's own row last, in whatever order its domain lists it", async () => {
    const id = await someone();
    const own = relations.erasure!.find((r) => r.column === "id")!;
    const first: DomainManifest = { ...relations, erasure: [own, ...relations.erasure!.filter((r) => r !== own)] };
    assert.equal((await planErasure(db, [first, gtm], id)).at(-1)?.table, "person");
  });

  it("does what each domain declares, as a person's run, and deletes the person", async () => {
    const id = await someone();
    const r = await erase(db, [relations, gtm], { subjectId: id, by: "an operator", processKey: "relations.person.erase" });
    assert.equal(await total(id), "0");
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0);
    assert.equal(r.steps.at(-1)?.outcome, "deleted");
    assert.deepEqual((await rows("select actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0], { actor_type: "human", actor_id: "an operator", status: "succeeded" });
  });

  it("keeps what a domain keeps under its basis, and empties the person it still names instead of deleting it", async () => {
    const id = await someone();
    const keeping: DomainManifest = { ...relations, erasure: relations.erasure!.map((r) => (r.table === "touch" ? { table: "touch", column: "person_id", do: "keep", basis: "an obligation the test invents" } : r)) };
    const r = await erase(db, [keeping, gtm], { subjectId: id, by: "an operator", processKey: "relations.person.erase" });
    assert.equal((await rows("select count(*)::int as n from relations.touch"))[0].n, 1);
    assert.deepEqual(await rows("select email, full_name from relations.person where id = $1", [id]), [{ email: null, full_name: null }]);
    assert.deepEqual(r.steps.map((s) => s.outcome).filter(Boolean), ["kept", "emptied"]);
  });

  it("does all of it or none of it", async () => {
    const id = await someone();
    // An answer the schema refuses — touches are append-only — fails the whole erasure.
    const wrong: DomainManifest = { ...relations, erasure: relations.erasure!.map((r) => (r.table === "touch" ? { table: "touch", column: "person_id", do: "anonymise", columns: ["sender"] } : r)) };
    await assert.rejects(erase(db, [wrong, gtm], { subjectId: id, by: "an operator", processKey: "relations.person.erase" }), (e: Error) => /append-only/.test(String((e.cause as Error | undefined)?.message ?? e.message)));
    assert.equal(await total(id), "7");
  });
});
