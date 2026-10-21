/**
 * Tests for `kernel-stop-protected` (decision 0057), run as an instance's
 * schedule runs it: the command as a process, from an instance root, so that
 * the registry it asks is the one an instance boots — the template's sandbox
 * target list and sequencer — and not one a test hands in. The runtime's own
 * tests cover the act's cases; these cover that the command reaches them, and
 * says what it does not keep.
 *
 * The root is a throwaway one linked to the template's files: the sandbox
 * sequencer writes its state file in the directory it runs from, and the
 * template's own must not be touched.
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
const database = `kernel_stop_protected_bin_${process.pid}`;
const template = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "stop-protected.ts");
let admin: Client;
let client: Client;
let url: string;
let cwd: string;
/** The register's version that writes: the template ships none, since a secret is generated (0058). */
const SECRET = generateSecret();

before(async () => {
  cwd = mkdtempSync(join(tmpdir(), "kernel-stop-protected-"));
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

/**
 * Cy, enrolled in `welcome` on email through the sandbox sequencer, at the
 * company the sandbox's data protects; and the sandbox holding Cy's lead
 * under the row's key. Cy's address is on another domain: only the
 * company's protection can stop Cy.
 */
async function cyAtTheProtectedAccount(): Promise<string> {
  const [{ id: companyId }] = (await client.query("insert into relations.company (name, domain) values ('customer', 'customer.example.net') returning id")).rows;
  const [{ id: personId }] = (await client.query("insert into relations.person (email, company_id) values ('cy@cy-consulting.example.org', $1) returning id", [companyId])).rows;
  const [{ id }] = (
    await client.query(
      "insert into acquisition.enrolment (person_id, company_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, $2, 'welcome', 'email', 'key-cy', 'enrolled', 'sandbox-sequencer', 'system') returning id",
      [personId, companyId],
    )
  ).rows;
  writeFileSync(stateFile(), JSON.stringify({ enrolments: { welcome: { "cy@cy-consulting.example.org": { key: "key-cy", at: new Date().toISOString() } } }, suppressed: [], crm: [], notes: [] }));
  return id;
}
const sandbox = () => JSON.parse(readFileSync(stateFile(), "utf8")) as { enrolments: Record<string, Record<string, unknown>>; suppressed: string[] };

beforeEach(async () => {
  rmSync(stateFile(), { force: true });
  if (client) await client.query("truncate relations.person, relations.company, core.run cascade");
});

function run(args: string[]): Promise<{ status: number | null; out: string }> {
  // The loader from here: the throwaway root does not resolve it on its own.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), command, ...args], { cwd, env: { ...process.env, DATABASE_URL: url, KERNEL_FINGERPRINT_T1: SECRET } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const stop = setTimeout(() => child.kill("SIGKILL"), 30_000);
  return new Promise((resolve) => child.on("close", (status) => (clearTimeout(stop), resolve({ status, out }))));
}

const PROMISE = /holds only as often as kernel-stop-protected or an enrolment run runs\. Between two runs, an account that became protected keeps receiving every step its sequences send\. The hook at enrolment alone is not that promise/;

describe("kernel-stop-protected", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("refuses to run without the protected set's age, before anything is opened", async () => {
    const r = await run(["--live"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--max-age \(minutes\) is required/);
    assert.equal((await client.query("select 1 from core.run")).rows.length, 0);
  });

  it("live, through the instance's bindings: suspends at the provider, suppresses the account, records the promise held, and says what it is not", async () => {
    const id = await cyAtTheProtectedAccount();
    const r = await run(["--max-age", "60", "--live", "--scheduled"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(sandbox().enrolments.welcome, {}, "the sandbox still holds Cy");
    assert.deepEqual(sandbox().suppressed.sort(), ["customer.example.net", "cy@cy-consulting.example.org"]);
    const [enrolment] = (await client.query("select state, suspension_run_id from acquisition.enrolment where id = $1", [id])).rows;
    assert.equal(enrolment.state, "suspended");
    const [recorded] = (await client.query("select r.id, r.trigger, r.process_key from acquisition.protection_held h join core.run r on r.id = h.run_id")).rows;
    assert.equal(recorded?.id, enrolment.suspension_run_id);
    assert.equal(recorded?.trigger, "cron");
    assert.equal(recorded?.process_key, "acquisition.protected.stop");
    assert.match(r.out, /suspended; recorded with what the adapter returned as its read-back/);
    assert.match(r.out, /suppression of customer\.example\.net through sequencer \(sandbox-sequencer\): the adapter answered that it applies customer\.example\.net, as of /);
    assert.doesNotMatch(r.out, /read back as of/);
    // The sandbox dates its protected set at the read, after the run started.
    assert.match(r.out, /the protected set: 1 account, computed .*, computed after its run started/);
    assert.match(r.out, /the promise held as of .*, recorded in acquisition\.protection_held/);
    assert.match(r.out, /before this run, no run had recorded the promise as held/);
    assert.match(r.out.replace(/\n/g, " "), PROMISE);

    // The next run finds nobody, holds the promise all the same, and says where it last held.
    const again = await run(["--max-age", "60", "--live"]);
    assert.equal(again.status, 0, again.out);
    assert.match(again.out, /no running enrolment is at a protected account/);
    assert.match(again.out, new RegExp(`before this run, the promise was last known to hold as of .* \\(run ${recorded.id}, its protected set computed after its run started\\)`));
    assert.equal((await client.query("select 1 from acquisition.protection_held")).rows.length, 2);
  });

  it("dry, says whom it would stop, writes nothing, and says the promise is not recorded", async () => {
    const id = await cyAtTheProtectedAccount();
    const r = await run(["--max-age", "60"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /would suspend/);
    assert.match(r.out, /a dry run: nothing was written, and the promise is not recorded as held/);
    assert.match(r.out.replace(/\n/g, " "), PROMISE);
    assert.deepEqual(Object.keys(sandbox().enrolments.welcome ?? {}), ["cy@cy-consulting.example.org"]);
    assert.deepEqual(sandbox().suppressed, []);
    assert.equal((await client.query("select state from acquisition.enrolment where id = $1", [id])).rows[0].state, "enrolled");
    assert.equal((await client.query("select 1 from acquisition.protection_held")).rows.length, 0);
  });
});
