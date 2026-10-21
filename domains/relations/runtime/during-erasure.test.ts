/**
 * Tests for what an erasure writes in the register (decisions 0052, 0062,
 * 0063), through `erase()` as `kernel-erase` calls it, against a real
 * database: the step is the module `domain.yaml` names, resolved from this
 * package, not one handed in.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import { validateDomain } from "@werunfoundry/core/manifest/validate";
import type { DomainManifest } from "@werunfoundry/core/manifest/types";
import type { ErasureReach } from "@werunfoundry/core/runtime/erase";
import { erase, ErasureRefused, planDuringErasure } from "@werunfoundry/core/runtime/erase";
import { fingerprinter, fingerprintOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_during_erasure_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;
let url: string;

const relations = loadDomain(join(import.meta.dirname, "../domain.yaml")).manifest!;
const vocabulary = identityVocabulary([relations], ["network_a"]);
const SECRET = generateSecret();
const nobody: Registry = { get: () => undefined, require: () => undefined as never, forChannel: () => undefined, all: () => [], sequence: () => [], list: () => [] };
const reachWith = (missing: string[] = []): ErasureReach => ({ registry: nobody, root: join(import.meta.dirname, ".."), fingerprints: fingerprinter("T1", SECRET, missing, vocabulary) });
const reach = reachWith();

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const u = new URL(base);
  u.pathname = `/${database}`;
  url = u.toString();
  client = new Client({ connectionString: url });
  await client.connect();
  for (const layer of ["../../../core", ".."]) {
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
  // The register refuses a truncate that would destroy an entry (0052); between tests, the triggers are set aside, as only a database's owner can.
  if (client) await client.query("set session_replication_role = replica; truncate relations.person, relations.company, core.run cascade; set session_replication_role = origin");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const email = { kind: "email", value: "ada@example.com" };
const profile = { kind: "social_profile_id", network: "network_a", value: "ada-1" };

/** Ada, with an address and a profile id, and an opt-out when `optedOut`. */
async function ada(optedOut: boolean): Promise<string> {
  const [{ id }] = await rows("insert into relations.person (email, external_id, opted_out_at) values ('ada@example.com', 'network_a:ada-1', $1) returning id", [optedOut ? new Date("2026-01-01T00:00:00Z") : null]);
  return id;
}

const erasing = (id: string, objects: boolean, domains: DomainManifest[] = [relations], r: ErasureReach | undefined = reach) =>
  erase(db, domains, { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects }, r);

describe("a step inside erasure, as declared (0062)", () => {
  it("is named by a domain of its own package only, and as a package export", () => {
    assert.ok(validateDomain({ ...relations }).ok, "relations' own declaration is refused");
    const acquisition = loadDomain(join(import.meta.dirname, "../../acquisition/domain.yaml")).manifest!;
    const r = validateDomain({ ...acquisition, duringErasure: "@werunfoundry/relations/runtime/during-erasure" });
    assert.ok(!r.ok && r.issues.some((i) => i.at === "duringErasure" && /of its own package/.test(i.message)), JSON.stringify(r.issues));
    assert.ok(!validateDomain({ ...relations, duringErasure: "./runtime/during-erasure.ts" }).ok);
  });
});

describe("an erasure keeps an objection as fingerprints (0052, 0062)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes one entry per key of a person whose opt-out is on record: the fingerprint, the chain, the run's start, the run, and nothing else", async () => {
    const id = await ada(true);
    const r = await erasing(id, false);
    const [run] = await rows("select started_at from core.run where id = $1", [r.runId]);
    const entries = await rows("select * from relations.suppression order by fingerprint");
    assert.deepEqual(
      entries.map((e) => Object.keys(e).sort()),
      [["chain", "fingerprint", "id", "run_id", "written_at"], ["chain", "fingerprint", "id", "run_id", "written_at"]],
    );
    assert.deepEqual(
      entries.map((e) => ({ fingerprint: e.fingerprint, chain: e.chain, writtenAt: e.written_at.toISOString(), runId: e.run_id })),
      [fingerprintOf(SECRET, email, vocabulary), fingerprintOf(SECRET, profile, vocabulary)].sort().map((fingerprint) => ({ fingerprint, chain: ["T1"], writtenAt: run.started_at.toISOString(), runId: r.runId })),
    );
    assert.deepEqual(r.during, [{ domain: "relations", acts: [{ what: "entries written in the register, one per key of a person who objected (decision 0052)", rows: 2 }] }]);
    assert.deepEqual(await rows("select count(*)::int as n from relations.person"), [{ n: 0 }]);
  });

  it("writes them for a person who had not opted out when the request includes not being contacted, the opt-out recorded at the run's start", async () => {
    const id = await ada(false);
    const r = await erasing(id, true);
    assert.equal((await rows("select count(*)::int as n from relations.suppression"))[0].n, 2);
    // Kept rather than deleted, the person's row shows the opt-out the step recorded.
    const kept: DomainManifest = { ...relations, erasure: relations.erasure!.map((rule) => (rule.table === "person" ? { table: "person", column: "id", do: "keep" as const, basis: "a test" } : rule)) };
    const other = (await rows("insert into relations.person (email) values ('bob@example.org') returning id"))[0].id;
    const k = await erasing(other, true, [kept]);
    const [{ opted_out_at }] = await rows("select opted_out_at from relations.person where id = $1", [other]);
    const [{ started_at }] = await rows("select started_at from core.run where id = $1", [k.runId]);
    assert.equal(opted_out_at.toISOString(), started_at.toISOString());
    assert.ok(r.runId);
  });

  it("writes nothing for a person who had not opted out when the request does not include it: nothing of them survives", async () => {
    const id = await ada(false);
    const r = await erasing(id, false);
    assert.deepEqual(await rows("select * from relations.suppression"), []);
    assert.equal(r.during[0]!.acts[0]!.rows, 0);
    assert.match(r.during[0]!.acts[0]!.what, /none, no opt-out is on record and the request includes none/);
  });

  it("refuses an erasure that does not say whether the request includes an objection, before any run opens", async () => {
    const id = await ada(false);
    await assert.rejects(erase(db, [relations], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase" } as never, reach), /says whether the request includes not being contacted, true or false \(decision 0062\)/);
    assert.deepEqual(await rows("select count(*)::int as n from core.run"), [{ n: 0 }]);
    assert.deepEqual(await rows("select count(*)::int as n from relations.person"), [{ n: 1 }]);
  });

  it("refuses an erasure given no fingerprint versions, and erases nobody", async () => {
    const id = await ada(true);
    const { fingerprints: _, ...noVersions } = reach;
    await assert.rejects(erasing(id, true, [relations], noVersions), (e: Error) => e instanceof ErasureRefused && /given no fingerprint versions to write under/.test(e.message));
    assert.deepEqual(await rows("select count(*)::int as n from relations.person"), [{ n: 1 }]);
    assert.deepEqual(await rows("select count(*)::int as n from relations.suppression"), [{ n: 0 }]);
  });

  it("rolls back with the erasure: an erasure that fails leaves no entry", async () => {
    const id = await ada(true);
    await rows("insert into relations.touch (person_id, channel, direction, unsolicited, sender, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', true, 'a mailbox', 'memory', 't1', now(), 'system')", [id]);
    // Touches are append-only: an answer the schema refuses fails the whole erasure, after the step ran.
    const wrong: DomainManifest = { ...relations, erasure: relations.erasure!.map((rule) => (rule.table === "touch" ? { table: "touch", column: "person_id", do: "anonymise" as const, columns: ["sender"] } : rule)) };
    await assert.rejects(erasing(id, true, [wrong]));
    assert.deepEqual(await rows("select count(*)::int as n from relations.suppression"), [{ n: 0 }]);
    assert.deepEqual(await rows("select count(*)::int as n from relations.person where opted_out_at is not null"), [{ n: 1 }]);
  });

  it("rolls back with the erasure through a pool too, where the transaction has a connection of its own", async () => {
    // On one client, a write beside the transaction lands in it anyway: only
    // a pool shows that the step writes through the transaction it is given.
    const pool = new Pool({ connectionString: url, max: 4 });
    try {
      const pooled = drizzle(pool) as unknown as Database;
      const id = await ada(true);
      await rows("insert into relations.touch (person_id, channel, direction, unsolicited, sender, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', true, 'a mailbox', 'memory', 't1', now(), 'system')", [id]);
      const wrong: DomainManifest = { ...relations, erasure: relations.erasure!.map((rule) => (rule.table === "touch" ? { table: "touch", column: "person_id", do: "anonymise" as const, columns: ["sender"] } : rule)) };
      await assert.rejects(erase(pooled, [wrong], { trigger: "cli", subjectId: id, by: "an operator", processKey: "relations.person.erase", objects: true }, reach));
      assert.deepEqual(await rows("select count(*)::int as n from relations.suppression"), [{ n: 0 }]);
    } finally {
      await pool.end();
    }
  });

  it("keeps the entry already there for a key shared with someone erased before", async () => {
    await erasing(await ada(true), false);
    const again = (await rows("insert into relations.person (email, opted_out_at) values ('ada@example.com', now()) returning id"))[0].id;
    const r = await erasing(again, false);
    assert.equal((await rows("select count(*)::int as n from relations.suppression"))[0].n, 2);
    assert.deepEqual(r.during[0]!.acts, [
      { what: "entries written in the register, one per key of a person who objected (decision 0052)", rows: 0 },
      { what: "keys already in the register, from someone erased before under the same key: the entry there stands", rows: 1 },
    ]);
  });

  it("says in a plan what it would write under either answer, and writes nothing", async () => {
    const id = await ada(false);
    const [plan] = await planDuringErasure(db, [relations], id, reach);
    assert.deepEqual(plan!.result.acts, [{ what: "entries it would write in the register, one per key, if the request includes not being contacted; none if it does not (decision 0052)", rows: 2 }]);
    const [yes] = await planDuringErasure(db, [relations], id, reach, true);
    assert.match(yes!.result.acts[0]!.what, /the request includes not being contacted/);
    assert.deepEqual(await rows("select count(*)::int as n from relations.suppression"), [{ n: 0 }]);
    assert.deepEqual(await rows("select opted_out_at from relations.person"), [{ opted_out_at: null }]);
  });

  it("counts, in a plan and an erasure, the entries a lost version no longer protects, and goes on (0063)", async () => {
    await rows("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T0}', now()), ($2, '{T0,T1}', now()), ($3, '{T1}', now())", ["1".repeat(64), "2".repeat(64), "3".repeat(64)]);
    const id = await ada(false);
    const lost = reachWith(["T0"]);
    const said = { what: "entries in the register keyed under a version whose secret is not set (T0): they protect nobody from now on (decision 0063)", rows: 2 };
    const [plan] = await planDuringErasure(db, [relations], id, lost);
    assert.deepEqual(plan!.result.acts[0], said);
    const r = await erasing(id, false, [relations], lost);
    assert.deepEqual(r.during[0]!.acts[0], said);
    assert.deepEqual(await rows("select count(*)::int as n from relations.person"), [{ n: 0 }]);
  });
});

describe("relations.suppression in the schema (0052, 0058)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  async function entry(): Promise<string> {
    const [{ id: run }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('relations.person.erase', 'cli', 'human') returning id");
    await rows("insert into relations.suppression (fingerprint, chain, written_at, run_id) values ($1, '{T1}', '2026-01-01T00:00:00Z', $2)", ["a".repeat(64), run]);
    return run;
  }
  const refused = /an entry is not edited; the one change admitted is a rewrap/;

  it("admits a rewrap: a new fingerprint under one more label at the end of its chain, its time and run kept (0058, §3)", async () => {
    await entry();
    await rows("update relations.suppression set fingerprint = $1, chain = '{T1,T2}'", ["b".repeat(64)]);
    assert.deepEqual(await rows("select fingerprint, chain from relations.suppression"), [{ fingerprint: "b".repeat(64), chain: ["T1", "T2"] }]);
  });

  it("refuses every other edit: two labels at once, a label before, a moved time, a chain grown on the same fingerprint, another run", async () => {
    await entry();
    for (const [set, params] of [
      ["fingerprint = $1, chain = '{T1,T2,T3}'", ["b".repeat(64)]],
      ["fingerprint = $1, chain = '{T0,T1}'", ["b".repeat(64)]],
      ["written_at = now()", []],
      ["chain = '{T1,T2}'", []],
    ] as const) {
      await assert.rejects(client.query(`update relations.suppression set ${set}`, [...params]), refused);
    }
    const [{ id: other }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('x', 'cli', 'human') returning id");
    await assert.rejects(client.query("update relations.suppression set run_id = $1", [other]), refused);
  });

  it("refuses a delete", async () => {
    await entry();
    await assert.rejects(client.query("delete from relations.suppression"), /an entry is never deleted/);
  });

  it("lets the run's deletion set its reference to null, and nothing else moves", async () => {
    const run = await entry();
    await rows("delete from core.run where id = $1", [run]);
    assert.deepEqual(await rows("select fingerprint, chain, run_id from relations.suppression"), [{ fingerprint: "a".repeat(64), chain: ["T1"], run_id: null }]);
  });

  it("refuses a truncate that would destroy an entry, named or by cascade, and lets an empty register go", async () => {
    await entry();
    for (const statement of ["truncate relations.suppression", "truncate core.run cascade"]) {
      await assert.rejects(client.query(statement), /the register is not truncated; it would cancel every objection it holds, in silence/);
    }
    assert.deepEqual(await rows("select count(*)::int as n from relations.suppression"), [{ n: 1 }]);
    await rows("set session_replication_role = replica; truncate relations.suppression; set session_replication_role = origin");
    await rows("truncate relations.suppression");
  });

  it("refuses a malformed fingerprint or chain, and a second entry for one fingerprint", async () => {
    await entry();
    for (const [fingerprint, chain] of [["ABC", "{T1}"], ["c".repeat(64), "{}"], ["c".repeat(64), "{t1}"]]) {
      await assert.rejects(client.query("insert into relations.suppression (fingerprint, chain, written_at) values ($1, $2, now())", [fingerprint, chain]), /suppression_(fingerprint|chain)_form/);
    }
    await assert.rejects(client.query("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T2}', now())", ["a".repeat(64)]), /suppression_fingerprint_uidx/);
  });
});
