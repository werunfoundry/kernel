/**
 * Tests for `kernel-erase` (decisions 0040, 0049), run as a person runs it:
 * the command itself, as a process, against a real database — without a
 * terminal, and inside one (`script` gives it a pseudo-terminal, and what is
 * typed goes in on it). The runtime's own tests cover what erasure does;
 * these cover that the gestures reach it, and that nothing reaches it any
 * other way. Of the person's commands it is the one whose effect cannot be
 * undone.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_erase_bin_${process.pid}`;
// The command boots an instance, so it runs from one: the template's root, where the domains resolve.
const cwd = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "erase.ts");
let admin: Client;
let client: Client;
let url: string;
let ada: string;

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
  for (const layer of ["../../../core", "..", "../../acquisition"]) {
    const migrations = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrations, f), "utf8"));
    }
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
  if (!client) return;
  await client.query("truncate relations.person, relations.company, core.run cascade");
  ada = (await client.query("insert into relations.person (email) values ('ada@example.com') returning id")).rows[0].id;
  await client.query("insert into relations.person (email) values ('bob@example.org')");
  const run = (await client.query("insert into core.run (process_key, trigger, actor_type) values ('acquisition.source', 'cli', 'system') returning id")).rows[0].id;
  await client.query(
    "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, company, person, person_id, subject) values ($1, 'person', 'kept', 'kept and recorded', '{}', $2, $3, 'person:a')",
    [run, JSON.stringify({ subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] }), ada],
  );
  await client.query(
    "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, company, person, subject) values ($1, 'person', 'opted_out', 'opted out', '{}', $2, 'person:b')",
    [run, JSON.stringify({ subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] })],
  );
});

/** Every table the command could change, and what in them names Ada. */
const state = async () =>
  (await client.query(
    `select (select count(*) from relations.person)::int as people, (select count(*) from core.run)::int as runs,
       (select count(*) from acquisition.sourcing_result)::int as results,
       (select count(*) from acquisition.sourcing_result where person is not null)::int as naming`,
  )).rows[0];
const untouched = { people: 2, runs: 1, results: 2, naming: 2 };

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

/** The command as a process. `terminal` runs it on a pseudo-terminal; `typed` is what the person types. */
function run(args: string[], opts: { terminal?: boolean; typed?: string } = {}): Promise<{ status: number | null; out: string }> {
  const argv = [process.execPath, "--import", "tsx", command, ...args];
  const child = opts.terminal
    ? spawn("script", ["-qec", argv.map(quote).join(" "), "/dev/null"], { cwd, env: { ...process.env, DATABASE_URL: url } })
    : spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, DATABASE_URL: url } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.stdin.end(opts.typed ?? "");
  // A command left waiting — on a confirmation nobody will type — is stopped, and reads as a failure.
  const stop = setTimeout(() => child.kill("SIGKILL"), 30_000);
  return new Promise((resolve) => child.on("close", (status) => (clearTimeout(stop), resolve({ status, out }))));
}

const erasing = () => ["--person", ada, "--by", "an operator"];

describe("kernel-erase", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("erases nothing without a terminal, even when the confirmation is piped in", async () => {
    const r = await run(erasing(), { typed: `${ada}\n` });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person erases, at a terminal\. Nothing was changed/);
    assert.deepEqual(await state(), untouched);
  });

  it("erases nothing when the id typed is not the one given", async () => {
    const r = await run(erasing(), { terminal: true, typed: "00000000-0000-0000-0000-000000000000\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /the id did not match\. Nothing was changed/);
    assert.deepEqual(await state(), untouched);
  });

  it("erases, at a terminal, once the id is typed again — the person deleted, the history kept naming nobody", async () => {
    const r = await run(erasing(), { terminal: true, typed: `${ada}\n` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /acquisition\.sourcing_result: 2 rows \(1 by keys\) — anonymise/);
    assert.match(r.out, /erased; the person's row was deleted/);
    assert.match(r.out, /Not reached by this command \(decision 0049\)[\s\S]*backups[\s\S]*execution logs[\s\S]*working copies[\s\S]*core\.event[\s\S]*the opt-out does not survive/);
    assert.deepEqual(await state(), { people: 1, runs: 2, results: 2, naming: 0 });
    assert.deepEqual((await client.query("select email from relations.person")).rows, [{ email: "bob@example.org" }]);
    const [erasure] = (await client.query("select trigger, actor_type, actor_id, status, process_key from core.run where process_key = 'relations.person.erase'")).rows;
    assert.deepEqual(erasure, { trigger: "cli", actor_type: "human", actor_id: "an operator", status: "succeeded", process_key: "relations.person.erase" });
  });

  it("shows the plan with --plan, without a terminal, says what it does not reach, and changes nothing", async () => {
    const r = await run(["--person", ada, "--plan"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /acquisition\.sourcing_result: 2 rows \(1 by keys\) — anonymise/);
    assert.match(r.out, /relations\.person: 1 row — delete/);
    assert.match(r.out, /Not reached by this command \(decision 0049\)[\s\S]*the opt-out does not survive/);
    assert.doesNotMatch(r.out, /Type the id again/);
    assert.deepEqual(await state(), untouched);
  });
});
