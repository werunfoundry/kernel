/**
 * Tests for `kernel-opt-out` (decisions 0065 §3, 0047), run as a person runs
 * it: the command as a process, from an instance root, so that the
 * sequencer it stops is the one an instance boots — the template's sandbox —
 * without a terminal, and inside one (`script` gives it a pseudo-terminal,
 * and what is typed goes in on it).
 *
 * The root is a throwaway one linked to the template's files: the sandbox
 * sequencer writes its state file in the directory it runs from.
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
const database = `kernel_opt_out_bin_${process.pid}`;
const template = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "opt-out.ts");
let admin: Client;
let client: Client;
let url: string;
let cwd: string;
const SECRET = generateSecret();

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "kernel-opt-out-"));
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

const stateFile = () => join(cwd, ".sandbox-state.json");
const held = () => Object.keys((JSON.parse(readFileSync(stateFile(), "utf8")) as { enrolments: Record<string, Record<string, unknown>> }).enrolments.welcome ?? {});

/** Cy, enrolled in `welcome` through the sandbox sequencer, which holds Cy's lead under the row's key. */
async function cyEnrolled(): Promise<{ personId: string; enrolmentId: string }> {
  const [{ id: companyId }] = (await client.query("insert into relations.company (name, domain) values ('open', 'open.example.org') returning id")).rows;
  const [{ id: personId }] = (await client.query("insert into relations.person (email, company_id) values ('cy@open.example.org', $1) returning id", [companyId])).rows;
  const [{ id: enrolmentId }] = (
    await client.query(
      "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'welcome', 'email', 'key-cy', 'enrolled', 'sandbox-sequencer', 'system') returning id",
      [personId, companyId],
    )
  ).rows;
  writeFileSync(stateFile(), JSON.stringify({ enrolments: { welcome: { "cy@open.example.org": { key: "key-cy", at: new Date().toISOString() } } }, suppressed: [], crm: [], notes: [] }));
  return { personId, enrolmentId };
}

beforeEach(async () => {
  rmSync(stateFile(), { force: true });
  if (client) await client.query("truncate relations.person, relations.company, core.run, core.event cascade");
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

const AT = "2026-10-20T09:30:00Z";
const record = ["--person", "cy@open.example.org", "--at", AT, "--by", "an operator"];
const optedOutAt = async (personId: string) => (await client.query("select opted_out_at from relations.person where id = $1", [personId])).rows[0]?.opted_out_at as Date | null;
const count = async (table: string) => (await client.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

describe("kernel-opt-out", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes nothing without a terminal, even when the address is piped in", async () => {
    const { personId } = await cyEnrolled();
    const r = await run(record, { typed: "cy@open.example.org\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person records it, at a terminal\. Nothing was written/);
    assert.equal(await optedOutAt(personId), null);
    assert.deepEqual([await count("core.run"), await count("core.event"), held()], [0, 0, ["cy@open.example.org"]]);
  });

  it("records the opt-out at the moment given, as the person's act, and stops what runs for them at the sequencer", async () => {
    const { personId, enrolmentId } = await cyEnrolled();
    const r = await run(record, { terminal: true, typed: "cy@open.example.org\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /never cleared/);
    assert.match(r.out, /recorded/);
    assert.match(r.out, /stopped at the provider: 1 suspended/);
    assert.deepEqual(await optedOutAt(personId), new Date(AT));
    assert.deepEqual(held(), [], "the sandbox still holds Cy");
    const [e] = (await client.query("select state from acquisition.enrolment where id = $1", [enrolmentId])).rows;
    assert.equal(e.state, "suspended");
    const [ev] = (await client.query("select e.kind, e.provider, e.occurred_at, e.payload, r.actor_type, r.actor_id, r.process_key, r.trigger from core.event e join core.run r on r.id = e.run_id")).rows;
    assert.deepEqual(ev, {
      kind: "acquisition.unsubscribe",
      provider: "terminal",
      occurred_at: new Date(AT),
      payload: { personId, recordedBy: "an operator" },
      actor_type: "human",
      actor_id: "an operator",
      process_key: "acquisition.opt-out.record",
      trigger: "cli",
    });
  });

  it("writes nothing when what is typed is another address", async () => {
    const { personId } = await cyEnrolled();
    const r = await run(record, { terminal: true, typed: "dee@open.example.org\n" });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /does not match\. Nothing was written/);
    assert.equal(await optedOutAt(personId), null);
    assert.deepEqual([await count("core.run"), await count("core.event"), held()], [0, 0, ["cy@open.example.org"]]);
  });

  it("keeps an opt-out already on record at its first moment", async () => {
    const { personId } = await cyEnrolled();
    await client.query("update relations.person set opted_out_at = '2026-10-01T00:00:00Z' where id = $1", [personId]);
    const r = await run(record, { terminal: true, typed: "cy@open.example.org\n" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /opted out since 2026-10-01T00:00:00\.000Z/);
    assert.match(r.out, /already on record: the first moment stands/);
    assert.deepEqual(await optedOutAt(personId), new Date("2026-10-01T00:00:00Z"));
  });

  it("shows the person and what runs for them on a dry run, without a terminal, and writes nothing", async () => {
    const { personId } = await cyEnrolled();
    const r = await run([...record, "--dry-run"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /no opt-out on record/);
    assert.match(r.out, /running for them: welcome \(enrolled\)/);
    assert.match(r.out, /dry run — would record .* Nothing was written/);
    assert.equal(await optedOutAt(personId), null);
    assert.deepEqual([await count("core.run"), held()], [0, ["cy@open.example.org"]]);
  });

  it("refuses a moment in the future, a time without its zone, a person not on record, and a missing --by", async () => {
    await cyEnrolled();
    for (const [args, why] of [
      [["--person", "cy@open.example.org", "--at", "2999-01-01", "--by", "x"], /not in the future/],
      [["--person", "cy@open.example.org", "--at", "2026-10-20T09:30:00", "--by", "x"], /with its zone/],
      [["--person", "bo@open.example.org", "--at", AT, "--by", "x"], /no person with the address bo@open\.example\.org/],
      [["--person", "cy@open.example.org", "--at", AT], /--person, --at and --by are required/],
    ] as const) {
      const r = await run([...args], { terminal: true, typed: "cy@open.example.org\n" });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, why);
    }
    assert.deepEqual([await count("core.run"), await count("core.event")], [0, 0]);
  });
});
