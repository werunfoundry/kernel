/**
 * Tests for `kernel-attest-stop` (decision 0056), run as a person runs it:
 * the command as a process, from the template's root, so that the registry
 * it asks is the one an instance boots — the sandbox sequencer, bound on
 * email — and not one a test hands in. The runtime's own tests cover the four
 * cases; these cover that the gesture reaches them, and only at a terminal.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Client } from "pg";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_attest_bin_${process.pid}`;
// The command boots an instance, so it runs from one: the template's root, where the domains resolve.
const cwd = join(import.meta.dirname, "../../../template");
const command = join(import.meta.dirname, "attest-stop.ts");
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
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(migrations, f), "utf8"));
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
  if (client) await client.query("truncate relations.person, core.run cascade");
});

/** Ada, enrolled in `welcome` on email through `provider`. */
async function enrolment(provider: string): Promise<string> {
  const [{ id }] = (await client.query("insert into relations.person (email) values ('ada@example.com') returning id")).rows;
  return (await client.query(
    "insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'key-ada', 'enrolled', $2, 'system') returning id",
    [id, provider],
  )).rows[0].id;
}
const row = async (id: string) => (await client.query("select state, suspension_attestation, suspension_read_back from acquisition.enrolment where id = $1", [id])).rows[0];

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
  const stop = setTimeout(() => child.kill("SIGKILL"), 30_000);
  return new Promise((resolve) => child.on("close", (status) => (clearTimeout(stop), resolve({ status, out }))));
}

const attesting = (id: string) => ["--enrolment", id, "--stopped-by-hand", "paused her by hand at the provider", "--by", "an operator"];

describe("kernel-attest-stop", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("records nothing without a terminal, even when the confirmation is piped in", async () => {
    const id = await enrolment("another-provider");
    const r = await run(attesting(id), { typed: `${id}\n` });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /a person attests, at a terminal\. Nothing was recorded/);
    assert.equal((await row(id)).state, "enrolled");
  });

  it("is refused where the instance's sequencer can still suspend: retrying the erasure is the remedy", async () => {
    const id = await enrolment("sandbox-sequencer");
    const r = await run(attesting(id), { terminal: true, typed: `${id}\n` });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /no attestation is open: the sequencer "sandbox-sequencer" can suspend this enrolment/);
    assert.equal((await row(id)).state, "enrolled");
  });

  it("records the person's word, at a terminal, where the instance binds another provider than the row's", async () => {
    const id = await enrolment("another-provider");
    const r = await run(attesting(id), { terminal: true, typed: `${id}\n` });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /attested \(other_provider\); recorded as a person's word, not as a provider's read-back/);
    assert.deepEqual(await row(id), {
      state: "suspended",
      suspension_attestation: { case: "other_provider", kind: "stopped_by_hand", how: "paused her by hand at the provider" },
      suspension_read_back: null,
    });
  });
});
