/**
 * Tests for `kernel-experiment` (decisions 0072, 0047), run as a person runs
 * it: the command as a process, from an instance root linked to the
 * template's files, without a terminal and inside one (`script` gives it a
 * pseudo-terminal, and what is typed goes in on it).
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
const database = `kernel_experiment_bin_${process.pid}`;
const template = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "experiment.ts");
let admin: Client;
let client: Client;
let url: string;
let cwd: string;
const SECRET = generateSecret();

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "kernel-experiment-"));
  for (const entry of readdirSync(template)) if (entry !== ".sandbox-state.json" && entry !== "manifest.yaml") symlinkSync(join(template, entry), join(cwd, entry));
  writeFileSync(join(cwd, "manifest.yaml"), `${readFileSync(join(template, "manifest.yaml"), "utf8")}\nfingerprints:\n  writes: T1\n  versions:\n    - { label: T1, check: ${checkValueOf(SECRET)}, reason: "a test" }\n`);
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
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(migrations, f), "utf8"));
  }
});

after(async () => {
  rmSync(cwd, { recursive: true, force: true });
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

beforeEach(async () => {
  if (client) await client.query("truncate core.experiment, relations.person, core.run cascade");
});

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

/** The command as a process. `terminal` runs it on a pseudo-terminal; `typed` is what the person types. */
function run(args: string[], opts: { terminal?: boolean; typed?: string } = {}): Promise<{ status: number | null; out: string }> {
  const argv = [process.execPath, "--import", import.meta.resolve("tsx"), command, ...args];
  const env = { ...process.env, DATABASE_URL: url, KERNEL_FINGERPRINT_T1: SECRET };
  const child = opts.terminal ? spawn("script", ["-qec", argv.map(quote).join(" "), "/dev/null"], { cwd, env }) : spawn(argv[0]!, argv.slice(1), { cwd, env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.stdin.end(opts.typed ?? "");
  const stop = setTimeout(() => child.kill("SIGKILL"), 30_000);
  return new Promise((resolve) => child.on("close", (status) => (clearTimeout(stop), resolve({ status, out }))));
}

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const record = ["record", "--slug", "spring", "--type", "campaign", "--hypothesis", "https://example.com/h/1", "--lane", "reviewed", "--by", "an operator"];
const start = ["start", "--slug", "spring", "--by", "an operator"];
const recorded = async () => {
  const [{ id }] = await rows("insert into core.experiment (slug, type, hypothesis_ref, lane) values ('spring', 'campaign', 'https://example.com/h/1', 'reviewed') returning id");
  return id as string;
};
const status = async () => (await rows("select status from core.experiment where slug = 'spring'"))[0]?.status as string | undefined;

describe("kernel-experiment", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("records nothing without a terminal, even when the slug is piped in", async () => {
    const r = await run(record, { typed: "spring\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /at a terminal\. Nothing was written/);
    assert.deepEqual(await rows("select count(*)::int as n from core.experiment"), [{ n: 0 }]);
  });

  it("records an experiment in draft, as the person's act, once its slug is typed again", async () => {
    const r = await run(record, { terminal: true, typed: "spring\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /nothing is contacted for it until a person starts it/);
    assert.deepEqual(await rows("select slug, type, hypothesis_ref, lane, status from core.experiment"), [
      { slug: "spring", type: "campaign", hypothesis_ref: "https://example.com/h/1", lane: "reviewed", status: "draft" },
    ]);
    assert.deepEqual(await rows("select process_key, actor_type, actor_id, status from core.run"), [
      { process_key: "core.experiment.record", actor_type: "human", actor_id: "an operator", status: "succeeded" },
    ]);
  });

  it("writes nothing when what is typed is another slug", async () => {
    const r = await run(record, { terminal: true, typed: "autumn\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual([await status(), (await rows("select count(*)::int as n from core.run"))[0].n], [undefined, 0]);
  });

  it("refuses a type no domain declares, a slug already on record, and a lane not said", async () => {
    const undeclared = await run(["record", "--slug", "spring", "--type", "raffle", "--hypothesis", "h", "--lane", "reviewed", "--by", "x"], { terminal: true, typed: "spring\n" });
    assert.match(undeclared.out, /no enabled domain declares the experiment type "raffle"/);
    const noLane = await run(["record", "--slug", "spring", "--type", "campaign", "--hypothesis", "h", "--by", "x"], { terminal: true, typed: "spring\n" });
    assert.match(noLane.out, /the lane is said, never assumed/);
    await recorded();
    const twice = await run(record, { terminal: true, typed: "spring\n" });
    assert.match(twice.out, /already on record \(draft\)/);
    assert.deepEqual([undeclared.status, noLane.status, twice.status], [1, 1, 1]);
    assert.deepEqual(await rows("select count(*)::int as n from core.experiment"), [{ n: 1 }]);
  });

  it("refuses to start an experiment with no template, and starts one with a template", async () => {
    const id = await recorded();
    const empty = await run(start, { terminal: true, typed: "spring\n" });
    assert.equal(empty.status, 1, empty.out);
    assert.match(empty.out, /it has no template/);
    assert.equal(await status(), "draft");

    await rows("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'Hello', 'A first line.')", [id]);
    const started = await run(start, { terminal: true, typed: "spring\n" });
    assert.equal(started.status, 0, started.out);
    assert.match(started.out, /variant a, step 1, email: Hello/);
    assert.match(started.out, /No command stops it yet/);
    assert.equal(await status(), "running");
    assert.deepEqual(await rows("select process_key, actor_id from core.run where status = 'succeeded'"), [{ process_key: "core.experiment.start", actor_id: "an operator" }]);

    const again = await run(start, { terminal: true, typed: "spring\n" });
    assert.equal(again.status, 1, again.out);
    assert.match(again.out, /the experiment is running: only one in draft is started/);
  });

  it("shows what a start would do on a dry run, without a terminal, and writes nothing", async () => {
    const id = await recorded();
    await rows("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'A first line.')", [id]);
    const r = await run([...start, "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /dry run — nothing was written/);
    assert.deepEqual([await status(), (await rows("select count(*)::int as n from core.run"))[0].n], ["draft", 0]);
  });
});
