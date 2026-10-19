/**
 * Tests for `kernel-list` (decision 0047), run as a person runs it: the
 * command itself, as a process, against a real database — without a
 * terminal, and inside one (`script` gives it a pseudo-terminal, and what is
 * typed goes in on it).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_list_bin_${process.pid}`;
// Run from the package, as an instance runs it from its root: pg and drizzle-orm resolve from here.
const cwd = join(import.meta.dirname, "..");
const command = join(import.meta.dirname, "list.ts");
const scratch = mkdtempSync(join(tmpdir(), "kernel-list-"));
const picked = join(scratch, "picked.txt");
let admin: Client;
let client: Client;
let url: string;

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
  for (const layer of ["../../../core", "../../relations", ".."]) {
    const migrations = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrations, f), "utf8"));
    }
  }
});

after(async () => {
  rmSync(scratch, { recursive: true, force: true });
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

beforeEach(async () => {
  if (client) {
    await client.query("truncate relations.list, acquisition.sourcing_result, relations.person, relations.company, core.run cascade");
    await client.query("insert into relations.person (email) values ('ada@example.com'), ('bob@example.com')");
    writeFileSync(picked, "ada@example.com\nbob@example.com\n");
  }
});

const count = async (table: string) => (await client.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
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
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
}

const fromFile = ["--key", "october", "--from-file", picked, "--by", "an operator"];

describe("kernel-list", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes nothing without a terminal, even when the confirmation is piped in", async () => {
    const r = await run(fromFile, { typed: "october\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person constitutes a list, at a terminal\. Nothing was written/);
    assert.deepEqual([await count("relations.list"), await count("core.run")], [0, 0]);
  });

  it("constitutes and seals the list, at a terminal, once the key is typed again", async () => {
    const r = await run(fromFile, { terminal: true, typed: "october\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /a selection, never a permission/);
    assert.match(r.out, /list october constituted and sealed, 2 members/);
    const [row] = (await client.query("select l.query->>'from' as source, l.sealed_at is not null as sealed, l.actor_id, k.process_key from relations.list l join core.run k on k.id = l.run_id")).rows;
    assert.deepEqual(row, { source: "hand", sealed: true, actor_id: "an operator", process_key: "acquisition.list.constitute" });
  });

  it("writes nothing when what is typed does not match", async () => {
    const r = await run(fromFile, { terminal: true, typed: "november\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual([await count("relations.list"), await count("core.run")], [0, 0]);
  });

  it("refuses a key that already names a list, and opens no run", async () => {
    await run(fromFile, { terminal: true, typed: "october\n" });
    const r = await run(fromFile, { terminal: true, typed: "october\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a list october already exists, constituted on .* by an operator with 2 members\. Nothing was written/);
    assert.deepEqual([await count("relations.list"), await count("core.run")], [1, 1]);
  });

  it("refuses a selection from a run and a file at once", async () => {
    const r = await run([...fromFile, "--from-run", "00000000-0000-0000-0000-000000000000"], { terminal: true, typed: "october\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /one of --from-run or --from-file, are required/);
    assert.deepEqual([await count("relations.list"), await count("core.run")], [0, 0]);
  });

  it("refuses a file with a line that names nobody on record, and names it", async () => {
    writeFileSync(picked, "ada@example.com\neve@example.com\n");
    const r = await run(fromFile, { terminal: true, typed: "october\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /eve@example\.com: no person with the address/);
    assert.deepEqual([await count("relations.person"), await count("relations.list"), await count("core.run")], [2, 0, 0]);
  });

  it("shows, on a dry run from a sourcing run, who it would hold, and writes nothing", async () => {
    const [{ id: runId }] = (await client.query("insert into core.run (process_key, trigger, actor_type, status) values ('acquisition.source', 'cli', 'human', 'succeeded') returning id")).rows;
    await client.query(
      "insert into acquisition.sourcing_result (run_id, pass, outcome, detail, person, company, person_id, subject) select $1, 'person', 'kept', 'kept', '{}'::jsonb, '{}'::jsonb, id, email from relations.person where email = 'ada@example.com'",
      [runId],
    );
    const r = await run(["--key", "october", "--from-run", runId, "--by", "an operator", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /list october: 1 members, from run/);
    assert.match(r.out, /- ada@example\.com/);
    assert.match(r.out, /dry run — nothing was written/);
    assert.deepEqual([await count("relations.list"), await count("core.run")], [0, 1]);
  });
});
