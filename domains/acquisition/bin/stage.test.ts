/**
 * Tests for `kernel-stage` (decision 0047), run as a person runs it: the
 * command itself, as a process, against a real database — without a
 * terminal, and inside one (`script` gives it a pseudo-terminal, and what is
 * typed goes in on it).
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_stage_bin_${process.pid}`;
// Run from the package, as an instance runs it from its root: pg and drizzle-orm resolve from here.
const cwd = join(import.meta.dirname, "..");
const command = join(import.meta.dirname, "stage.ts");
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
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

beforeEach(async () => {
  if (client) {
    await client.query("truncate acquisition.person_state, acquisition.company_state, relations.person, relations.company, core.run cascade");
    await client.query("insert into relations.person (email) values ('ada@example.com')");
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
  // A command left waiting — on a confirmation nobody will type — is stopped, and reads as a failure.
  const stop = setTimeout(() => child.kill("SIGKILL"), 20_000);
  return new Promise((resolve) => child.on("close", (status) => (clearTimeout(stop), resolve({ status, out }))));
}

const declare = ["--person", "ada@example.com", "--stage", "engaged", "--at", "2026-09-01T09:30:00Z", "--by", "an operator"];

describe("kernel-stage", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes nothing without a terminal, even when the confirmation is piped in", async () => {
    const r = await run(declare, { typed: "ada@example.com\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person declares, at a terminal\. Nothing was written/);
    assert.deepEqual([await count("acquisition.person_state"), await count("core.run")], [0, 0]);
  });

  it("declares, at a terminal, once the address is typed again, and says what cannot be corrected", async () => {
    const r = await run(declare, { terminal: true, typed: "ada@example.com\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /cannot be corrected: a stage has no neutral value/);
    const [row] = (await client.query("select s.stage, s.at, s.actor_id, k.process_key from acquisition.person_state s join core.run k on k.id = s.run_id")).rows;
    assert.deepEqual(row, { stage: "engaged", at: new Date("2026-09-01T09:30:00Z"), actor_id: "an operator", process_key: "acquisition.stage.declare" });
    assert.deepEqual((await client.query("select trigger from core.run")).rows, [{ trigger: "cli" }], "a command says its channel: cli (0048)");
  });

  it("writes nothing when what is typed does not match", async () => {
    const r = await run(declare, { terminal: true, typed: "ada@example.org\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual([await count("acquisition.person_state"), await count("core.run")], [0, 0]);
  });

  it("refuses the same stage from another moment, and writes nothing", async () => {
    await run(declare, { terminal: true, typed: "ada@example.com\n" });
    const r = await run(["--person", "ada@example.com", "--stage", "engaged", "--at", "2026-09-03", "--by", "an operator"], { terminal: true, typed: "ada@example.com\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /already stands as engaged since 2026-09-01T09:30:00\.000Z/);
    assert.deepEqual([await count("acquisition.person_state"), await count("core.run")], [1, 1]);
  });

  it("refuses two subjects or none, a person not on record, and a time without its zone", async () => {
    for (const [args, why] of [
      [["--person", "ada@example.com", "--company", "example.com", "--stage", "engaged", "--at", "2026-09-01", "--by", "x"], /one of --person or --company/],
      [["--stage", "engaged", "--at", "2026-09-01", "--by", "x"], /one of --person or --company/],
      [["--person", "bob@example.com", "--stage", "engaged", "--at", "2026-09-01", "--by", "x"], /no person with the address bob@example\.com/],
      [["--person", "ada@example.com", "--stage", "engaged", "--at", "2026-09-01T09:30:00", "--by", "x"], /with its zone/],
      [["--person", "ada@example.com", "--stage", "customer", "--at", "2026-09-01", "--by", "x"], /--stage is one of targeted, engaged, opportunity/],
    ] as const) {
      const r = await run([...args], { terminal: true, typed: "ada@example.com\n" });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, why);
    }
    assert.deepEqual([await count("relations.person"), await count("acquisition.person_state"), await count("core.run")], [1, 0, 0]);
  });

  it("shows what it would write on a dry run, without a terminal, and writes nothing", async () => {
    const r = await run([...declare, "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry run — would declare ada@example\.com engaged from 2026-09-01T09:30:00\.000Z\. Nothing was written/);
    assert.deepEqual([await count("acquisition.person_state"), await count("core.run")], [0, 0]);
  });
});
