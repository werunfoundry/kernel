/**
 * Tests for `kernel-decide` (decision 0047), run as a person runs it: the
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
const database = `kernel_decide_bin_${process.pid}`;
// Run from the package, as an instance runs it from its root: pg and drizzle-orm resolve from here.
const cwd = join(import.meta.dirname, "..");
const command = join(import.meta.dirname, "decide.ts");
const scratch = mkdtempSync(join(tmpdir(), "kernel-decide-"));
const readings = join(scratch, "readings.json");
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
  const migrations = join(import.meta.dirname, "../db/migrations");
  for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
    await client.query(readFileSync(join(migrations, f), "utf8"));
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
    await client.query("truncate core.decision, core.experiment, core.run cascade");
    await client.query("insert into core.experiment (slug, type, hypothesis_ref) values ('autumn-test', 'campaign', 'https://example.com/h')");
    writeFileSync(readings, JSON.stringify([{ metric: "acquisition.replied", value: 0.04, readAt: "2026-09-30T00:00:00Z" }]));
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

const decide = ["--experiment", "autumn-test", "--conclusion", "killed: below the threshold", "--readings", readings, "--by", "an operator"];

describe("kernel-decide", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes nothing without a terminal, even when the confirmation is piped in", async () => {
    const r = await run(decide, { typed: "autumn-test\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person decides, at a terminal\. Nothing was written/);
    assert.deepEqual([await count("core.decision"), await count("core.run")], [0, 0]);
  });

  it("records the decision and its readings as given, at a terminal, once the slug is typed again", async () => {
    const r = await run([...decide, "--why", "two weeks under"], { terminal: true, typed: "autumn-test\n" });
    assert.equal(r.status, 0, r.out);
    const [row] = (await client.query("select d.conclusion, d.rationale, d.readings, d.actor_id, k.process_key from core.decision d join core.run k on k.id = d.run_id")).rows;
    assert.deepEqual(row, {
      conclusion: "killed: below the threshold",
      rationale: "two weeks under",
      readings: [{ metric: "acquisition.replied", value: 0.04, readAt: "2026-09-30T00:00:00Z" }],
      actor_id: "an operator",
      process_key: "core.decision.record",
    });
    assert.deepEqual((await client.query("select trigger from core.run")).rows, [{ trigger: "cli" }], "a command says its channel: cli (0048)");
  });

  it("records a second decision when run again, after showing the first", async () => {
    await run(decide, { terminal: true, typed: "autumn-test\n" });
    const r = await run(decide, { terminal: true, typed: "autumn-test\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /1 decision already recorded/);
    assert.match(r.out, /by an operator: killed: below the threshold/);
    assert.equal(await count("core.decision"), 2);
  });

  it("writes nothing when what is typed does not match", async () => {
    const r = await run(decide, { terminal: true, typed: "spring-test\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual([await count("core.decision"), await count("core.run")], [0, 0]);
  });

  it("refuses readings neither given nor said to be none, readings that are not readings, and an experiment not on record", async () => {
    writeFileSync(join(scratch, "bad.json"), JSON.stringify([{ metric: "acquisition.replied", value: "4%", readAt: "2026-09-30T00:00:00Z" }]));
    for (const [args, why] of [
      [["--experiment", "autumn-test", "--conclusion", "x", "--by", "an operator"], /one of --readings <file\.json> or --no-readings is required/],
      [["--experiment", "autumn-test", "--conclusion", "x", "--readings", join(scratch, "bad.json"), "--by", "an operator"], /reading 1's value is neither a number nor null/],
      [["--experiment", "spring-test", "--conclusion", "x", "--no-readings", "--by", "an operator"], /no experiment spring-test is on record/],
    ] as const) {
      const r = await run([...args], { terminal: true, typed: "autumn-test\n" });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, why);
    }
    assert.deepEqual([await count("core.decision"), await count("core.run")], [0, 0]);
  });

  it("records an empty set of readings when it is said, and shows it on a dry run first", async () => {
    const dry = await run(["--experiment", "autumn-test", "--conclusion", "continue", "--no-readings", "--by", "an operator", "--dry-run"]);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /on 0 readings/);
    assert.deepEqual([await count("core.decision"), await count("core.run")], [0, 0]);
    const r = await run(["--experiment", "autumn-test", "--conclusion", "continue", "--no-readings", "--by", "an operator"], { terminal: true, typed: "autumn-test\n" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual((await client.query("select readings from core.decision")).rows, [{ readings: [] }]);
  });
});
