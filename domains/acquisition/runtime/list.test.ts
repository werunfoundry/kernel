/**
 * Tests for a list a person constitutes (decisions 0037, 0047), against a
 * real database: from what a sourcing run kept, or from a hand selection;
 * frozen, in its own run, and never filtered for consent or protection. And
 * the boundaries 0047 draws around the person's acts, read in the sources.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";
import { readList } from "@werunfoundry/relations/runtime/list";

import { constituteSelection, selectFromLines, selectFromRun } from "./list.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_list_${process.pid}`;
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
  for (const layer of ["../../../core", "../../relations", ".."]) {
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
  if (client) await client.query("truncate relations.list, acquisition.sourcing_result, relations.person, relations.company, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;
const aPerson = async (email: string, optedOut = false) =>
  (await rows("insert into relations.person (email, opted_out_at) values ($1, $2) returning id", [email, optedOut ? new Date() : null]))[0].id as string;
const aCompany = async (domain: string) => (await rows("insert into relations.company (name, domain) values ($1, $1) returning id", [domain]))[0].id as string;
const aSourcingRun = async (over: { processKey?: string; dryRun?: boolean; status?: string } = {}) =>
  (
    await rows("insert into core.run (process_key, trigger, actor_type, dry_run, status) values ($1, 'cli', 'human', $2, $3) returning id", [
      over.processKey ?? "acquisition.source",
      over.dryRun ?? false,
      over.status ?? "succeeded",
    ])
  )[0].id as string;
const aResult = (runId: string, outcome: string, personId: string | null, subject: string) =>
  client.query(
    "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, person, company, person_id, subject) values ($1, 'person', $2, $3, '{}'::jsonb, '{\"domain\":\"example.com\"}'::jsonb, $4, $5)",
    [runId, outcome, `${outcome} by the run`, personId, subject],
  );

describe("a list from what a sourcing run kept", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("holds the people the run kept and recorded, and keeps where they came from", async () => {
    const [ada, bob] = [await aPerson("ada@example.com"), await aPerson("bob@example.com")];
    const runId = await aSourcingRun();
    await aResult(runId, "kept", ada, "person:0a1b");
    await aResult(runId, "kept", bob, "person:2c3d");
    await aResult(runId, "protected", null, "person:4e5f");
    // Excluded, though recorded: an opted-out person is on record, and is not kept.
    await aResult(runId, "opted_out", await aPerson("eve@example.com", true), "person:6a7b");
    // Kept but naming nobody recorded: a live run does not write one, and the schema does not bar it.
    await aResult(runId, "kept", null, "person:8c9d");
    const selection = await selectFromRun(db, runId);
    assert.deepEqual(selection.query, { from: "acquisition.sourcing_result", runId, outcome: "kept" });
    assert.deepEqual(selection.members.map((m) => ("personId" in m ? m.personId : undefined)).sort(), [ada, bob].sort());
    assert.ok(selection.members.every((m) => m.reason === "kept by the run"));
    // The run's subject is a digest; a person confirms on the addresses.
    assert.deepEqual([...selection.shown].sort(), ["ada@example.com", "bob@example.com"]);
  });

  it("refuses a run that is not a finished, live sourcing run", async () => {
    await assert.rejects(selectFromRun(db, "00000000-0000-0000-0000-000000000000"), /no run .* is on record/);
    await assert.rejects(selectFromRun(db, await aSourcingRun({ processKey: "acquisition.enrol.x" })), /not a sourcing run/);
    await assert.rejects(selectFromRun(db, await aSourcingRun({ dryRun: true })), /was a dry run/);
    await assert.rejects(selectFromRun(db, await aSourcingRun({ status: "running" })), /is still running/);
    await assert.rejects(selectFromRun(db, await aSourcingRun({ status: "failed" })), /ended as failed/);
  });
});

describe("a list from a hand selection", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("names people by address and companies by domain, blank lines and comments aside", async () => {
    const [ada, acme] = [await aPerson("ada@example.com"), await aCompany("example.org")];
    const text = "# chosen by hand\nADA@example.com\n\nhttps://www.example.org/\n";
    const selection = await selectFromLines(db, text, "picked.txt");
    assert.deepEqual(selection.members, [{ personId: ada }, { companyId: acme }]);
    assert.equal(selection.query.from, "hand");
    assert.equal(selection.query.file, "picked.txt");
    assert.match(String(selection.query.sha256), /^[0-9a-f]{64}$/);
  });

  it("refuses a file that names nobody", async () => {
    await assert.rejects(selectFromLines(db, "# only a comment\n\n", "picked.txt"), /picked\.txt names nobody/);
  });

  it("selects nobody when one line names no recorded subject, and names that line", async () => {
    await aPerson("ada@example.com");
    await assert.rejects(selectFromLines(db, "ada@example.com\nbob@example.com\n", "picked.txt"), /bob@example\.com: no person with the address/);
    assert.equal(await count("relations.person"), 1);
  });
});

describe("constituting the selection", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is a person's act, in its own run, and seals the list", async () => {
    const ada = await aPerson("ada@example.com");
    const selection = await selectFromLines(db, "ada@example.com", "picked.txt");
    const r = await constituteSelection(db, { key: "october", selection, by: "an operator" });
    assert.deepEqual({ constituted: r.constituted, members: r.members }, { constituted: true, members: 1 });
    assert.deepEqual((await rows("select process_key, actor_type, actor_id, status from core.run where id = $1", [r.runId]))[0], {
      process_key: "acquisition.list.constitute",
      actor_type: "human",
      actor_id: "an operator",
      status: "succeeded",
    });
    const read = await readList(db, "october");
    assert.ok(read?.sealedAt instanceof Date);
    assert.equal(read.actorId, "an operator");
    assert.deepEqual(read.members, [{ personId: ada, companyId: null, reason: null }]);
  });

  it("refuses a key that already names a list, before any run is opened", async () => {
    await aPerson("ada@example.com");
    const selection = await selectFromLines(db, "ada@example.com", "picked.txt");
    await constituteSelection(db, { key: "october", selection, by: "an operator" });
    const runs = await count("core.run");
    await assert.rejects(constituteSelection(db, { key: "october", selection, by: "another operator" }), /a list october already exists, constituted on .* by an operator with 1 members/);
    assert.equal(await count("core.run"), runs);
  });

  it("refuses a selection that names nobody, and one made by nobody, before any run", async () => {
    await aPerson("ada@example.com");
    const selection = await selectFromLines(db, "ada@example.com", "picked.txt");
    await assert.rejects(constituteSelection(db, { key: "empty", selection: { ...selection, members: [] }, by: "an operator" }), /names nobody/);
    await assert.rejects(constituteSelection(db, { key: "nobody", selection, by: " " }), /who constitutes it is required/);
    assert.equal(await count("core.run"), 0);
  });

  it("filters nobody: a person who opted out is selected, because a list is not a permission", async () => {
    const eve = await aPerson("eve@example.com", true);
    const selection = await selectFromLines(db, "eve@example.com", "picked.txt");
    await constituteSelection(db, { key: "october", selection, by: "an operator" });
    assert.deepEqual((await readList(db, "october"))?.members.map((m) => m.personId), [eve]);
  });
});

/* -------------------------------------------------------------------------- */
/* The boundaries 0047 draws, in the sources                                   */
/* -------------------------------------------------------------------------- */

describe("the boundaries of a person's acts", () => {
  const here = (path: string) => join(import.meta.dirname, path);
  const read = (path: string) => readFileSync(here(path), "utf8");
  const sources = (dir: string): string[] =>
    readdirSync(here(dir), { withFileTypes: true }).flatMap((e) => {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : sources(path);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
    });
  // Every file a run is made of, that reads protection or runs unattended.
  const runs = ["./enrol.ts", "./source.ts", "./protection.ts", "./inbound.ts", "../bin/enrol.ts", "../bin/source.ts", "../bin/inbound.ts"];

  it("never write the customer fact from the domain that prospects", () => {
    const all = sources("..");
    assert.ok(all.length > 10, `the walk found ${all.length} sources`);
    for (const path of all) {
      const text = read(path);
      assert.ok(!/declareRelationship/.test(text), `${path} reaches the relationship's writer`);
      const fromSchema = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@werunfoundry\/relations\/db\/schema"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
      assert.ok(!fromSchema.some((name) => /^relationship/.test(name)), `${path} imports the relationship's tables`);
    }
  });

  it("feed no protection from a declared relationship: the runs that read protection never read one", () => {
    for (const path of runs) assert.ok(!/relationship/i.test(read(path)), `${path} reaches a declared relationship`);
  });

  it("are made by no run: a run never declares a stage, constitutes a person's list or records a decision", () => {
    for (const path of runs) {
      const text = read(path);
      assert.ok(!/declareStage|constituteSelection|constituteList|recordDecision/.test(text), `${path} reaches a person's act`);
    }
  });
});
