/**
 * Tests for the writes relations owns — people, companies, touches — against
 * a real database, because what they rest on is in the DDL: the partial
 * unique indexes that make a race insert one row, the unique key that makes a
 * replayed touch no second touch, and the trigger that keeps touches
 * append-only.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary, normalizeIdentity } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Database } from "@werunfoundry/core/runtime/run";

import { findPerson, recordCompany, recordPerson, recordTouch } from "./record.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_record_${process.pid}`;
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
  for (const layer of ["../../../core", ".."]) {
    const migrations = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrations, f), "utf8"));
    }
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
  if (client) await client.query("truncate relations.touch, relations.person, relations.company, core.run cascade");
});

const person = (...keys: Identity["keys"]): Identity => ({ subject: "person", keys });
const company = (...keys: Identity["keys"]): Identity => ({ subject: "company", keys });
const email = (value: string) => ({ kind: "email", value });
const profile = (value: string) => ({ kind: "social_profile_id", value, network: "net_a" });
const rows = async (sql: string) => (await client.query(sql)).rows;

describe("recordPerson", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("records once, and finds the same row again by either key", async () => {
    const a = await recordPerson(db, person(email("Ada@Example.com"), profile("42")), { fullName: "Ada" });
    const b = await recordPerson(db, person(email("ada@example.com")));
    const c = await recordPerson(db, person(profile("42")));
    assert.ok("id" in a && "id" in b && "id" in c);
    assert.equal(a.id, b.id);
    assert.equal(a.id, c.id);
    assert.deepEqual(await rows("select email, external_id, full_name from relations.person"), [{ email: "ada@example.com", external_id: "net_a:42", full_name: "Ada" }]);
  });

  it("fills a key that was missing, and never overwrites one that was not", async () => {
    await recordPerson(db, person(email("ada@example.com")));
    await recordPerson(db, person(email("ada@example.com"), profile("42")));
    assert.deepEqual(await rows("select email, external_id from relations.person"), [{ email: "ada@example.com", external_id: "net_a:42" }]);
  });

  it("never overwrites a key: another address on the same id leaves the recorded one", async () => {
    await recordPerson(db, person(email("ada@example.com"), profile("42")));
    await recordPerson(db, person(email("ada@elsewhere.example.org"), profile("42")));
    assert.deepEqual(await rows("select email from relations.person"), [{ email: "ada@example.com" }]);
  });

  it("refuses to merge two recorded people that each hold one of the keys", async () => {
    await recordPerson(db, person(email("ada@example.com")));
    await recordPerson(db, person(profile("42")));
    const r = await recordPerson(db, person(email("ada@example.com"), profile("42")));
    assert.ok("conflict" in r && /two recorded people/.test(r.conflict), JSON.stringify(r));
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 2);
  });

  it("refuses a shared address on someone with another immutable id: two people, by 0013", async () => {
    await recordPerson(db, person(email("desk@example.com"), profile("1")));
    const r = await recordPerson(db, person(email("desk@example.com"), profile("2")));
    assert.ok("conflict" in r && /another immutable id/.test(r.conflict), JSON.stringify(r));
  });

  it("refuses an identity with no key it can record a person by", async () => {
    const r = await recordPerson(db, person({ kind: "social_profile_handle", value: "ada", network: "net_a" }));
    assert.ok("conflict" in r, JSON.stringify(r));
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0);
  });

  it("finds without writing", async () => {
    assert.deepEqual(await findPerson(db, person(email("ada@example.com"))), { none: true });
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0);
  });
});

describe("recordCompany", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("records by domain, with the domain as its label when no name is known", async () => {
    const a = await recordCompany(db, company({ kind: "domain", value: "Open.Example.com" }));
    const b = await recordCompany(db, company({ kind: "domain", value: "open.example.com" }, { kind: "social_company_id", value: "7", network: "net_a" }), { name: "Open" });
    assert.ok("id" in a && "id" in b && a.id === b.id);
    assert.deepEqual(await rows("select name, domain, external_id from relations.company"), [{ name: "open.example.com", domain: "open.example.com", external_id: "net_a:7" }]);
  });

  it("records a domain as its host, so two spellings are one company (decision 0028)", async () => {
    const a = await recordCompany(db, company({ kind: "domain", value: "http://WWW.Open.example.com/about" }));
    const b = await recordCompany(db, company({ kind: "domain", value: "open.example.com" }));
    assert.ok("id" in a && "id" in b && a.id === b.id);
    assert.deepEqual(await rows("select domain from relations.company"), [{ domain: "open.example.com" }]);
  });
});

describe("recordTouch", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const touch = async (over: Record<string, unknown> = {}) => {
    const p = await recordPerson(db, person(email("ada@example.com")));
    assert.ok("id" in p);
    return recordTouch(db, {
      personId: p.id,
      channel: "email",
      direction: "outbound",
      provider: "memory",
      providerEventId: "evt-1",
      occurredAt: new Date("2026-06-01T12:00:00Z"),
      actor: { type: "system" },
      ...over,
    });
  };

  it("records a provider event once: the replay is not a second touch", async () => {
    assert.deepEqual(await touch(), { recorded: true });
    assert.deepEqual(await touch({ direction: "inbound" }), { recorded: false });
    assert.equal((await rows("select count(*)::int as n from relations.touch"))[0].n, 1);
  });

  it("is append-only in the schema: a recorded touch cannot be rewritten", async () => {
    const [first, other] = await rows("insert into core.run (process_key, trigger, actor_type) values ('a', 'cli', 'system'), ('b', 'cli', 'system') returning id");
    await touch({ runId: first.id });
    await assert.rejects(client.query("update relations.touch set outcome = 'replied'"), /append-only/);
    // To a run that exists, so that only the trigger can refuse it.
    await assert.rejects(client.query("update relations.touch set run_id = $1", [other.id]), /append-only/);
    assert.deepEqual(await rows("select outcome, run_id from relations.touch"), [{ outcome: null, run_id: first.id }]);
  });

  it("still lets a deleted run take its attribution with it", async () => {
    const [run] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', 'system') returning id");
    await touch({ runId: run.id });
    await client.query("delete from core.run where id = $1", [run.id]);
    assert.deepEqual(await rows("select run_id from relations.touch"), [{ run_id: null }]);
  });
});

describe("relations' own vocabulary", () => {
  it("declares its domain key a host, so normalising a company reduces a URL to it (decision 0028)", () => {
    const loaded = loadDomain(join(import.meta.dirname, "../domain.yaml"));
    assert.ok(loaded.manifest, JSON.stringify(loaded.issues));
    const n = normalizeIdentity(company({ kind: "domain", value: "http://WWW.Open.example.com/" }), identityVocabulary([loaded.manifest]));
    assert.deepEqual(n.keys, [{ kind: "domain", value: "open.example.com" }]);
  });
});
