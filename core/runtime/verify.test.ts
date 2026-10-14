/**
 * Tests for verify.
 *
 * Nothing injected. Each test builds an instance on disk, with a real
 * `node_modules` holding the kernel's domains and the instance's own `pg` and
 * `drizzle-orm`, points it at a provider that answers over HTTP, and lets
 * verify open and close a real run in a real database (CLAUDE.md §5: a test
 * that injects what it should cross must also cross it).
 *
 * The database is created for this file and dropped after it. `node --test`
 * runs files in parallel, and the run recorder's tests drop the core schema
 * when they start.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import { verify } from "./verify.js";

const base = process.env.TEST_DATABASE_URL;
const kernel = join(import.meta.dirname, "../..");
const made: string[] = [];
const database = `kernel_verify_${process.pid}`;
let url = "";
let admin: Client;
let server: Server;
let port = 0;
const calls: { path: string; runId: string | undefined }[] = [];

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const target = new URL(base);
  target.pathname = `/${database}`;
  url = target.toString();

  const db = new Client({ connectionString: url });
  await db.connect();
  const migrations = join(kernel, "core/db/migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await db.query(readFileSync(join(migrations, file), "utf8"));
  }
  await db.end();

  server = createServer(async (req, res) => {
    calls.push({ path: req.url ?? "", runId: req.headers["x-run-id"] as string | undefined });
    if (req.url?.startsWith("/sever")) {
      // The database drops verify's connection mid-run, from its own side —
      // the way a pooler or a restart does — so closing the run cannot work.
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [database],
      );
      // Long enough for the termination to reach verify's client while it is
      // idle, waiting on this very response. That is the case that kills a
      // process: an idle client with no "error" listener throws from an event.
      await new Promise((r) => setTimeout(r, 200));
    }
    res.statusCode = req.url?.startsWith("/down") ? 503 : 200;
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server?.close();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** An adapter that probes `path` on the test provider, carrying the run id. */
const probing = (path: string) => `
export default ({ options }) => ({
  provider: "fixture",
  async probe(ctx) {
    const r = await fetch(options.baseUrl + "${path}", { headers: { "x-run-id": ctx.runId } });
    return r.ok ? { ok: true, value: undefined }
                : { ok: false, error: { code: "unavailable", message: "upstream " + r.status, retryable: true } };
  },
});
`;

/**
 * An instance on disk; `driver: false` leaves out pg and drizzle-orm. `truths`
 * are files under `truths/`; giving any enables `gtm`, which declares a kind.
 */
function instance(
  adapter: string,
  {
    driver = true,
    truths = {} as Record<string, string>,
    truthsDir = "folder" as "folder" | "absent" | "file",
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "verify-"));
  made.push(root);
  const link = (name: string, to: string) => {
    const at = join(root, "node_modules", name);
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(to, at, "dir");
  };
  link("@werunfoundry/relations", join(kernel, "domains/relations"));
  link("@werunfoundry/gtm", join(kernel, "domains/gtm"));
  const domains = Object.keys(truths).length ? "[relations, gtm]" : "[relations]";
  if (truthsDir === "folder") mkdirSync(join(root, "truths"));
  if (truthsDir === "file") writeFileSync(join(root, "truths"), "not a folder\n");
  for (const [name, body] of Object.entries(truths)) writeFileSync(join(root, "truths", name), body);
  // The template's own copies: the ones an instance installs.
  if (driver) {
    link("pg", join(kernel, "template/node_modules/pg"));
    link("drizzle-orm", join(kernel, "template/node_modules/drizzle-orm"));
  }
  writeFileSync(
    join(root, "manifest.yaml"),
    [
      "instance: test",
      "truthsDir: truths",
      `enabledDomains: ${domains}`,
      "providers:",
      `  - { contract: crm, adapter: ./adapter.mjs, env: [], options: { baseUrl: "http://127.0.0.1:${port}" } }`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "adapter.mjs"), adapter);
  return root;
}

async function run(root: string, env: Record<string, string> = { DATABASE_URL: url }) {
  const lines: string[] = [];
  const code = await verify({ root, env, say: (l) => lines.push(l) });
  return { code, said: lines.join("\n") };
}

const row = async (said: string) => {
  const id = said.match(/run: ([0-9a-f-]{36}) opened/)?.[1];
  assert.ok(id, `no run opened:\n${said}`);
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query("select status, dry_run, actor_id, error from core.run where id = $1", [id]);
  await db.end();
  return { id, ...rows[0] };
};

const countRuns = async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  const { rows } = await db.query("select count(*)::int as n from core.run");
  await db.end();
  return rows[0].n as number;
};

describe("verify", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("makes the round trip: a dry run opened, the provider probed with its id, the run closed", async () => {
    const { code, said } = await run(instance(probing("/up")));
    assert.equal(code, 0, said);
    const r = await row(said);
    assert.deepEqual([r.status, r.dry_run, r.actor_id], ["succeeded", true, "verify"]);
    assert.ok(calls.some((c) => c.path === "/up" && c.runId === r.id), "the provider never saw the run's id");
    assert.match(said, /This configuration is real\./);
  });

  it("records a probe that fails, and says the configuration is not real", async () => {
    const { code, said } = await run(instance(probing("/down")));
    assert.equal(code, 1);
    const r = await row(said);
    assert.equal(r.status, "failed");
    assert.match(r.error, /crm: unavailable/);
    assert.match(said, /plausible, not real/);
  });

  it("reports a run it could not close, closes its connection, and does not throw", async () => {
    const { code, said } = await run(instance(probing("/sever")));
    assert.equal(code, 1);
    assert.match(said, /could not be closed/);
    // Honest about the row: the database is the one that went away, so the
    // outcome could not be written and it still reads `running`.
    assert.equal((await row(said)).status, "running");
  });

  it("does not report an adapter without a probe as healthy", async () => {
    const { code, said } = await run(instance("export default () => ({ provider: 'fixture' });\n"));
    assert.equal(code, 0, said);
    assert.match(said, /offers no probe/);
    assert.match(said, /Not probed: crm\./);
    assert.doesNotMatch(said, /This configuration is real/);
  });

  it("opens nothing when boot refuses", async () => {
    const root = instance(probing("/up"));
    writeFileSync(join(root, "manifest.yaml"), "instance: test\ntruthsDir: t\nenabledDomains: [nowhere]\nproviders: []\n");
    const before = await countRuns();
    const { code, said } = await run(root);
    assert.equal(code, 1);
    assert.match(said, /boot: refused/);
    assert.equal(await countRuns(), before);
  });

  it("says where a run would go when there is no database", async () => {
    const { code, said } = await run(instance(probing("/up")), {});
    assert.equal(code, 1);
    assert.match(said, /DATABASE_URL is not set/);
  });

  it("refuses a truth no enabled domain understands, and still makes the round trip", async () => {
    const { code, said } = await run(
      instance(probing("/up"), {
        truths: { "odd.yaml": "key: odd\nkind: horoscope\nowner: ops\nvalidatedAt: \"2026-01-01\"\n" },
      }),
    );
    assert.equal(code, 1);
    assert.match(said, /no enabled domain declares the truth kind "horoscope"/);
    assert.match(said, /truths: 0 loaded, 1 refused/);
    const r = await row(said);
    assert.equal(r.status, "failed");
    assert.match(r.error, /truths: 1 refused/);
  });

  it("warns about a stale truth and does not fail on it", async () => {
    const { code, said } = await run(
      instance(probing("/up"), {
        truths: { "icp.yaml": "key: old\nkind: icp\nowner: ops\nvalidatedAt: \"2020-01-01\"\n" },
      }),
    );
    assert.equal(code, 0, said);
    assert.match(said, /! truths\/icp\.yaml:validatedAt/);
    assert.match(said, /truths: 1 loaded$/m);
  });

  it("warns about a truths directory that does not exist, and does not fail on it", async () => {
    const { code, said } = await run(instance(probing("/up"), { truthsDir: "absent" }));
    assert.equal(code, 0, said);
    assert.match(said, /! truths\n\s+does not exist/);
    assert.match(said, /truths: 0 loaded$/m);
  });

  it("refuses a truths directory that cannot be read", async () => {
    const { code, said } = await run(instance(probing("/up"), { truthsDir: "file" }));
    assert.equal(code, 1);
    assert.match(said, /✖ truths\n\s+cannot be listed/);
  });

  it("uses the instance's driver, and says so when the instance has none", async () => {
    const { code, said } = await run(instance(probing("/up"), { driver: false }));
    assert.equal(code, 1);
    assert.match(said, /add both to its dependencies/);
  });
});
