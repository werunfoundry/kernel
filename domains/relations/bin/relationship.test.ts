/**
 * Tests for `kernel-relationship` (decision 0047), run as a person runs it:
 * the command itself, as a process, against a real database — without a
 * terminal, and inside one (`script` gives it a pseudo-terminal, and what is
 * typed goes in on it). The runtime's own tests cover the verb; these cover
 * that the gestures reach it, and that nothing reaches it any other way.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_relationship_bin_${process.pid}`;
// Run from the package, as an instance runs it from its root: pg and drizzle-orm resolve from here.
const cwd = join(import.meta.dirname, "..");
const command = join(import.meta.dirname, "relationship.ts");
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
  for (const layer of ["../../../core", ".."]) {
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
    await client.query("truncate relations.relationship, relations.person, relations.company, core.run cascade");
    await client.query("insert into relations.company (name, domain) values ('Example', 'example.com')");
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

const declare = ["--company", "example.com", "--status", "customer", "--at", "2026-09-01", "--by", "an operator"];

describe("kernel-relationship", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes nothing without a terminal, even when the confirmation is piped in", async () => {
    const r = await run(declare, { typed: "example.com\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person declares, at a terminal\. Nothing was written/);
    assert.deepEqual([await count("relations.relationship"), await count("core.run")], [0, 0]);
  });

  it("declares, at a terminal, once the domain is typed again — as its own run with the person as actor", async () => {
    const r = await run([...declare, "--why", "signed"], { terminal: true, typed: "example.com\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /A wrong moment cannot be corrected/);
    assert.match(r.out, /declared: example\.com customer from 2026-09-01T00:00:00\.000Z/);
    const [row] = (await client.query("select r.status, r.at, r.reason, r.actor_id, k.process_key, k.actor_type from relations.relationship r join core.run k on k.id = r.run_id")).rows;
    assert.deepEqual(row, { status: "customer", at: new Date("2026-09-01T00:00:00Z"), reason: "signed", actor_id: "an operator", process_key: "relations.relationship.declare", actor_type: "human" });
  });

  it("writes nothing when what is typed does not match", async () => {
    const r = await run(declare, { terminal: true, typed: "example.org\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual([await count("relations.relationship"), await count("core.run")], [0, 0]);
  });

  it("writes nothing, and opens no run, for the same declaration again", async () => {
    await run(declare, { terminal: true, typed: "example.com\n" });
    const r = await run(declare, { terminal: true, typed: "example.com\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /already the declaration on record\. Nothing was written/);
    assert.deepEqual([await count("relations.relationship"), await count("core.run")], [1, 1]);
  });

  it("refuses the same status from another moment", async () => {
    await run(declare, { terminal: true, typed: "example.com\n" });
    const r = await run(["--company", "example.com", "--status", "customer", "--at", "2026-09-05", "--by", "an operator"], { terminal: true, typed: "example.com\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /already stands as customer since 2026-09-01/);
    assert.deepEqual([await count("relations.relationship"), await count("core.run")], [1, 1]);
  });

  it("refuses a person, a company not on record, and a moment not said", async () => {
    for (const [args, why] of [
      [["--person", "ada@example.com", "--status", "customer", "--at", "2026-09-01", "--by", "an operator"], /on a company, not on a person alone/],
      [["--company", "example.org", "--status", "customer", "--at", "2026-09-01", "--by", "an operator"], /no company with the domain example\.org/],
      [["--company", "example.com", "--status", "customer", "--by", "an operator"], /--at and --by are required/],
      [["--company", "example.com", "--status", "client", "--at", "2026-09-01", "--by", "an operator"], /--status is one of customer, former_customer, none/],
    ] as const) {
      const r = await run([...args], { terminal: true, typed: "example.com\n" });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, why);
    }
    assert.deepEqual([await count("relations.company"), await count("relations.relationship"), await count("core.run")], [1, 0, 0]);
  });

  it("shows what it would write on a dry run, without a terminal, and writes nothing", async () => {
    const r = await run([...declare, "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry run — would declare example\.com customer from 2026-09-01T00:00:00\.000Z\. Nothing was written/);
    assert.deepEqual([await count("relations.relationship"), await count("core.run")], [0, 0]);
  });
});
