/**
 * Tests for `kernel-template` (decisions 0072, 0047), run as a person runs
 * it: the command as a process, from an instance root linked to the
 * template's files, without a terminal and inside one.
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
const database = `kernel_template_bin_${process.pid}`;
const template = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "template.ts");
let admin: Client;
let client: Client;
let url: string;
let cwd: string;
const SECRET = generateSecret();

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "kernel-template-"));
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
const body = (name: string, text: string) => (writeFileSync(join(cwd, name), `${text}\n`), name);
const recordAt = (variant: string, step: string, file: string, more: string[] = []) => [
  "--experiment", "spring", "--variant", variant, "--step", step, "--channel", "email", "--body", file, "--by", "an operator", ...more,
];
let experimentId: string;

describe("kernel-template", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(async () => {
    [{ id: experimentId }] = await rows("insert into core.experiment (slug, type, hypothesis_ref, lane) values ('spring', 'campaign', 'https://example.com/h/1', 'reviewed') returning id");
  });

  it("records nothing without a terminal, even when the slug is piped in", async () => {
    const r = await run(recordAt("a", "1", body("one.txt", "Hello")), { typed: "spring\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /at a terminal\. Nothing was written/);
    assert.deepEqual(await rows("select count(*)::int as n from acquisition.template"), [{ n: 0 }]);
  });

  it("shows the whole text, then records it as the person's act once the slug is typed again", async () => {
    const r = await run(recordAt("a", "1", body("one.txt", "Hello {{firstName}},\n\nA first line."), ["--subject", "A subject", "--delay-days", "2"]), { terminal: true, typed: "spring\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /subject: A subject/);
    assert.match(r.out, /step 1, email, 2 days after the step before/);
    assert.match(r.out, /Hello \{\{firstName\}\},\r?\n\r?\nA first line\./);
    assert.deepEqual(await rows("select variant, step, channel, subject, body, delay_days, corrects from acquisition.template"), [
      { variant: "a", step: 1, channel: "email", subject: "A subject", body: "Hello {{firstName}},\n\nA first line.", delay_days: 2, corrects: null },
    ]);
    assert.deepEqual(await rows("select process_key, actor_type, actor_id from core.run"), [{ process_key: "acquisition.template.record", actor_type: "human", actor_id: "an operator" }]);
  });

  it("writes nothing when what is typed is another slug", async () => {
    const r = await run(recordAt("a", "1", body("one.txt", "Hello")), { terminal: true, typed: "autumn\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.deepEqual(await rows("select count(*)::int as n from acquisition.template"), [{ n: 0 }]);
  });

  it("never rewrites: refuses a step on record, replaces it while no draft cites it, and refuses once one does", async () => {
    await rows("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello')", [experimentId]);
    const plain = await run(recordAt("a", "1", body("fix.txt", "Hello, fixed")), { terminal: true, typed: "spring\n" });
    assert.equal(plain.status, 1, plain.out);
    assert.match(plain.out, /already on record at this step, and is never rewritten/);

    const replaced = await run(recordAt("a", "1", body("fix.txt", "Hello, fixed"), ["--replace"]), { terminal: true, typed: "spring\n" });
    assert.equal(replaced.status, 0, replaced.out);
    assert.match(replaced.out, /the one before it withdrawn/);
    const [{ id: templateId, body: kept }] = await rows("select id, body from acquisition.template");
    assert.equal(kept, "Hello, fixed");

    const [{ id: personId }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    await rows("insert into acquisition.draft (experiment_id, person_id, template_id, step, rendered_body) values ($1, $2, $3, 1, 'Hello, fixed')", [experimentId, personId, templateId]);
    const cited = await run(recordAt("a", "1", body("again.txt", "Hello again"), ["--replace"]), { terminal: true, typed: "spring\n" });
    assert.equal(cited.status, 1, cited.out);
    assert.match(cited.out, /a draft cites the template on record at this step, so it stays/);
    assert.deepEqual(await rows("select body from acquisition.template"), [{ body: "Hello, fixed" }]);
  });

  it("records a correction of an arm, and refuses a correction of a correction", async () => {
    await rows("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello')", [experimentId]);
    const fixed = await run(recordAt("b", "1", body("b.txt", "Hello, fixed"), ["--corrects", "a"]), { terminal: true, typed: "spring\n" });
    assert.equal(fixed.status, 0, fixed.out);
    assert.match(fixed.out, /a correction of a: not an arm/);
    const chained = await run(recordAt("c", "1", body("c.txt", "Hello, fixed again"), ["--corrects", "b"]), { terminal: true, typed: "spring\n" });
    assert.equal(chained.status, 1, chained.out);
    assert.match(chained.out, /a correction names an arm of its experiment, and "b" is none/);
    assert.deepEqual(await rows("select variant, corrects from acquisition.template order by variant"), [
      { variant: "a", corrects: null },
      { variant: "b", corrects: "a" },
    ]);
  });

  it("says one day, not one days", async () => {
    const r = await run([...recordAt("a", "2", body("two.txt", "Hello")), "--delay-days", "1", "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /step 2, email, 1 day after the step before/);
  });

  it("refuses a channel no domain declares, and shows a dry run without writing", async () => {
    const wrong = await run(["--experiment", "spring", "--variant", "a", "--step", "1", "--channel", "fax", "--body", body("one.txt", "Hello"), "--by", "x"], { terminal: true, typed: "spring\n" });
    assert.equal(wrong.status, 1, wrong.out);
    assert.match(wrong.out, /no enabled domain declares the channel "fax"/);
    const dry = await run([...recordAt("a", "1", body("one.txt", "Hello")), "--dry-run"]);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.out, /dry run — nothing was written/);
    assert.deepEqual([(await rows("select count(*)::int as n from acquisition.template"))[0].n, (await rows("select count(*)::int as n from core.run"))[0].n], [0, 0]);
  });
});
