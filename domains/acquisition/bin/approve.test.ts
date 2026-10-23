/**
 * Tests for `kernel-approve` (decisions 0027, 0047), run as a person runs it:
 * the command itself, as a process, against a real database — without a
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
const database = `kernel_approve_bin_${process.pid}`;
// Run from the package, as an instance runs it from its root: pg and drizzle-orm resolve from here.
const cwd = join(import.meta.dirname, "..");
const command = join(import.meta.dirname, "approve.ts");
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

const BODY = "Hello Ada,\n\nA first line.\n\nA second one.";

beforeEach(async () => {
  if (!client) return;
  await client.query("truncate acquisition.draft, acquisition.template, relations.person, core.experiment, core.run cascade");
  const experimentId = (await client.query("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('exp-approve', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).rows[0].id;
  const templateId = (await client.query("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'Hello', 'One.') returning id", [experimentId])).rows[0].id;
  for (const [email, name, subject, body, at] of [
    ["ada@example.com", "Ada", "Hello Ada", BODY, "2026-09-01T09:00:00Z"],
    ["bob@example.com", "Bob", null, "Hello Bob.", "2026-09-01T09:01:00Z"],
  ] as const) {
    const personId = (await client.query("insert into relations.person (email, full_name) values ($1, $2) returning id", [email, name])).rows[0].id;
    await client.query(
      "insert into acquisition.draft (experiment_id, person_id, template_id, step, state, rendered_subject, rendered_body, actor_type, actor_id, created_at) values ($1, $2, $3, 1, 'awaiting_review', $4, $5, 'agent', 'a drafting agent', $6)",
      [experimentId, personId, templateId, subject, body, at],
    );
  }
});

const count = async (table: string) => (await client.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
const states = async () =>
  (await client.query("select p.email, d.state, d.decided_by from acquisition.draft d join relations.person p on p.id = d.person_id order by p.email")).rows.map((r) => [r.email, r.state, r.decided_by]);
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

const approveAll = ["--experiment", "exp-approve", "--by", "an operator"];
const untouched = [
  ["ada@example.com", "awaiting_review", null],
  ["bob@example.com", "awaiting_review", null],
];

describe("kernel-approve", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("approves nothing without a terminal, even when the address is piped in", async () => {
    const r = await run(approveAll, { typed: "ada@example.com\nbob@example.com\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person approves, at a terminal\. Nothing was written/);
    assert.deepEqual(await states(), untouched);
    assert.equal(await count("core.run"), 0);
  });

  it("shows each draft whole, and approves only the one whose address is typed again, in a run of its own", async () => {
    const r = await run(approveAll, { terminal: true, typed: "ada@example.com\n\n" });
    assert.equal(r.status, 0, r.out);
    const shown = r.out.replace(/\r\n/g, "\n");
    assert.ok(shown.includes(`---- body, as it will be sent ----\n${BODY}\n---- end of body ----`), shown);
    assert.match(shown, /draft 1 of 2 — to ada@example\.com \(Ada\), step 1, email\nsubject: Hello Ada/);
    assert.match(shown, /draft 2 of 2 — to bob@example\.com \(Bob\), step 1, email\nsubject: \(none: the step is sent without one\)/);
    assert.match(shown, /approve: 1 approved, 1 left awaiting review\./);
    assert.deepEqual(await states(), [
      ["ada@example.com", "approved", "an operator"],
      ["bob@example.com", "awaiting_review", null],
    ]);
    const [row] = (await client.query("select d.actor_type, d.actor_id, d.edited_before_approval, k.process_key, k.trigger, k.actor_type as run_actor, k.status from acquisition.draft d join core.run k on k.id = d.run_id where d.state = 'approved'")).rows;
    assert.deepEqual(row, { actor_type: "human", actor_id: "an operator", edited_before_approval: false, process_key: "acquisition.draft.approve", trigger: "cli", run_actor: "human", status: "succeeded" });
  });

  it("approves one draft per address typed, each its own run", async () => {
    const r = await run(approveAll, { terminal: true, typed: "ada@example.com\nbob@example.com\n" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(await states(), [
      ["ada@example.com", "approved", "an operator"],
      ["bob@example.com", "approved", "an operator"],
    ]);
    assert.equal(await count("core.run where process_key = 'acquisition.draft.approve'"), 2);
  });

  it("approves nothing when what is typed is another address", async () => {
    const r = await run(approveAll, { terminal: true, typed: "bob@example.com\nada@example.com\n" });
    assert.equal(r.status, 0, r.out);
    assert.equal((r.out.match(/what was typed does not match: left awaiting review/g) ?? []).length, 2, r.out);
    assert.deepEqual(await states(), untouched);
    assert.equal(await count("core.run"), 0);
  });

  it("approves nothing more once the input ends", async () => {
    // Ctrl-D on an empty line: the terminal's end of input.
    const r = await run(approveAll, { terminal: true, typed: "\x04" });
    assert.match(r.out, /the input ended\. Nothing more was approved/);
    assert.deepEqual(await states(), untouched);
    assert.equal(await count("core.run"), 0);
  });

  it("shows what awaits review on a dry run, without a terminal, and writes nothing", async () => {
    const r = await run([...approveAll, "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.out.includes(BODY), r.out);
    assert.match(r.out, /dry run — nothing was approved\. Nothing was written/);
    assert.deepEqual(await states(), untouched);
    assert.equal(await count("core.run"), 0);
  });

  it("refuses an experiment not on record, and a missing --by", async () => {
    for (const [args, why] of [
      [["--experiment", "nothing-here", "--by", "an operator"], /no experiment "nothing-here" is on record/],
      [["--experiment", "exp-approve"], /--experiment and --by are required/],
    ] as const) {
      const r = await run([...args], { terminal: true, typed: "ada@example.com\n" });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, why);
    }
    assert.deepEqual(await states(), untouched);
    assert.equal(await count("core.run"), 0);
  });
});
