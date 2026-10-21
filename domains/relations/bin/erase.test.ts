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
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

import { checkValueOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_erase_bin_${process.pid}`;
const template = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "erase.ts");
/** The version that writes, generated as every secret is (0058); and an older one whose secret is lost (0063). */
const SECRET = generateSecret();
const LOST = generateSecret();
const version = (label: string, secret: string) => `    - { label: ${label}, check: ${checkValueOf(secret)}, reason: "a test" }`;

/**
 * The command boots an instance, so it runs from one: the template's files,
 * where the domains resolve, and a manifest that declares the register's
 * versions (0058) — the template ships none, since a version is generated.
 */
function instance(versions: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kernel-erase-"));
  for (const entry of readdirSync(template)) if (entry !== "manifest.yaml" && entry !== ".sandbox-state.json") symlinkSync(join(template, entry), join(dir, entry));
  writeFileSync(join(dir, "manifest.yaml"), `${readFileSync(join(template, "manifest.yaml"), "utf8")}\nfingerprints:\n  writes: T1\n  versions:\n${versions.join("\n")}\n`);
  return dir;
}
const roots: string[] = [];
let cwd: string;
let admin: Client;
let client: Client;
let url: string;
let ada: string;

before(async () => {
  cwd = instance([version("T1", SECRET)]);
  roots.push(cwd);
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
  for (const r of roots) rmSync(r, { recursive: true, force: true });
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

/**
 * The command as a process. `terminal` runs it on a pseudo-terminal; `typed`
 * is what the person types; `root` and `env` stand for another instance.
 */
function run(args: string[], opts: { terminal?: boolean; typed?: string; root?: string; env?: Record<string, string> } = {}): Promise<{ status: number | null; out: string }> {
  const argv = [process.execPath, "--import", import.meta.resolve("tsx"), command, ...args];
  const env = { ...process.env, DATABASE_URL: url, KERNEL_FINGERPRINT_T1: SECRET, ...opts.env };
  const at = opts.root ?? cwd;
  const child = opts.terminal
    ? spawn("script", ["-qec", argv.map(quote).join(" "), "/dev/null"], { cwd: at, env })
    : spawn(argv[0]!, argv.slice(1), { cwd: at, env });
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
    const r = await run(erasing(), { terminal: true, typed: `${ada}\nno\n` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /acquisition\.sourcing_result: 2 rows \(1 by keys\) — anonymise/);
    assert.match(r.out, /erased; the person's row was deleted/);
    assert.match(r.out, /Not reached by this command \(decision 0049\)[\s\S]*backups[\s\S]*execution logs[\s\S]*working copies[\s\S]*core\.event[\s\S]*the sequencer's steps already on their way[\s\S]*what the provider keeps[\s\S]*the opt-out survives only as fingerprints/);
    assert.deepEqual(await state(), { people: 1, runs: 2, results: 2, naming: 0 });
    assert.deepEqual((await client.query("select email from relations.person")).rows, [{ email: "bob@example.org" }]);
    const [erasure] = (await client.query("select trigger, actor_type, actor_id, status, process_key from core.run where process_key = 'relations.person.erase'")).rows;
    assert.deepEqual(erasure, { trigger: "cli", actor_type: "human", actor_id: "an operator", status: "succeeded", process_key: "relations.person.erase" });
  });

  const entries = async () => (await client.query("select chain, run_id is not null as attributed from relations.suppression order by chain")).rows;

  it("asks whether the request includes not being contacted, and on yes keeps the objection as one entry per key (0052)", async () => {
    const r = await run(erasing(), { terminal: true, typed: `${ada}\nyes\n` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Does the request include not being contacted\? Type yes or no/);
    assert.match(r.out, /during erasure, relations: 1 entries written in the register, one per key of a person who objected \(decision 0052\)/);
    assert.deepEqual(await entries(), [{ chain: ["T1"], attributed: true }]);
    assert.deepEqual((await client.query("select email from relations.person")).rows, [{ email: "bob@example.org" }]);
  });

  it("on no, erases and keeps nothing of the person", async () => {
    const r = await run(erasing(), { terminal: true, typed: `${ada}\nno\n` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /during erasure, relations: 0 entries written in the register: none/);
    assert.deepEqual(await entries(), []);
  });

  it("erases nothing on any other answer, or on a closed input: only yes or no answers (0052)", async () => {
    for (const typed of [`${ada}\nmaybe\n`, `${ada}\n\n`, `${ada}\n`]) {
      const r = await run(erasing(), { terminal: true, typed });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /only yes or no answers whether the request includes not being contacted \(decision 0052\)\. Nothing was changed/);
      assert.deepEqual(await state(), untouched);
      assert.deepEqual(await entries(), []);
    }
  });

  it("does not ask a person whose opt-out is on record: their objection is kept", async () => {
    await client.query("update relations.person set opted_out_at = now() where id = $1", [ada]);
    const r = await run(erasing(), { terminal: true, typed: `${ada}\n` });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Does the request include/);
    assert.deepEqual(await entries(), [{ chain: ["T1"], attributed: true }]);
  });

  it("goes on when an older version's secret is lost, and says what its entries no longer protect (0063)", async () => {
    const root = instance([version("T1", SECRET), version("T0", LOST)]);
    roots.push(root);
    const run0 = (await client.query("insert into core.run (process_key, trigger, actor_type) values ('relations.person.erase', 'cli', 'human') returning id")).rows[0].id;
    await client.query("insert into relations.suppression (fingerprint, chain, written_at, run_id) values ($1, '{T0}', now(), $2)", ["0".repeat(64), run0]);
    const r = await run(erasing(), { terminal: true, typed: `${ada}\nno\n`, root });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /KERNEL_FINGERPRINT_T0 is not set: the entries under version T0 protect nobody/);
    assert.match(r.out, /during erasure, relations: 1 entries in the register keyed under a version whose secret is not set \(T0\): they protect nobody from now on \(decision 0063\)/);
    assert.match(r.out, /erased; the person's row was deleted/);
  });

  it("does not start when the version that writes has no secret: an objection could not be kept (0063)", async () => {
    const r = await run(erasing(), { terminal: true, typed: `${ada}\nyes\n`, env: { KERNEL_FINGERPRINT_T1: "" } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /KERNEL_FINGERPRINT_T1 is not set, and version T1 writes/);
    assert.deepEqual(await state(), untouched);
  });

  it("shows the plan with --plan, without a terminal, says what it does not reach, and changes nothing", async () => {
    const r = await run(["--person", ada, "--plan"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /acquisition\.sourcing_result: 2 rows \(1 by keys\) — anonymise/);
    assert.match(r.out, /relations\.person: 1 row — delete/);
    assert.match(r.out, /Not reached by this command \(decision 0049\)[\s\S]*the opt-out survives only as fingerprints/);
    assert.doesNotMatch(r.out, /Type the id again/);
    assert.deepEqual(await state(), untouched);
  });
});
