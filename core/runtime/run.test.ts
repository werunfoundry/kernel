/**
 * Tests for the run recorder, against a real Postgres.
 *
 * A fake database here would test the fake. What is worth knowing is whether
 * the enum accepts the status, whether the timestamp lands, and whether the
 * insert returns the row the code assumes — none of which a mock can answer.
 *
 * Set TEST_DATABASE_URL to run them. They are skipped without it so that a
 * clone with no database still passes its suite; CI always sets it, so the
 * skip is a local convenience and never a silent hole.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Client } from "pg";

import { run as runTable } from "../db/schema.js";
import type { Database } from "./run.js";
import { openRun, withRun } from "./run.js";

const url = process.env.TEST_DATABASE_URL;
const migrations = join(import.meta.dirname, "../db/migrations");

let client: Client;
let db: Database;

// Top level, not inside a describe: one connection for the whole file, opened
// before the first test and closed after the last. A per-describe `after`
// closes it under the feet of the next one.
before(async () => {
  if (!url) return;
  client = new Client({ connectionString: url });
  await client.connect();
  // The schema under test, applied from the migration that ships — so this
  // fails too if the generated SQL ever stops being valid.
  await client.query("drop schema if exists core cascade");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await client.query(readFileSync(join(migrations, file), "utf8"));
  }
  db = drizzle(client) as unknown as Database;
});

after(async () => {
  await client?.end();
});

const read = async (id: string) => {
  const rows = await db.select().from(runTable).where(eq(runTable.id, id));
  return rows[0];
};

describe("the run recorder", { skip: url ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("opens a row and hands back a context pointing at it", async () => {
    const open = await openRun(db, {
      processKey: "test.open",
      trigger: "cli",
      actor: { type: "agent", id: "tester" },
      dryRun: true,
    });

    assert.equal(open.context.runId, open.id);
    assert.equal(open.context.dryRun, true);
    assert.deepEqual(open.context.actor, { type: "agent", id: "tester" });

    const row = await read(open.id);
    assert.equal(row?.status, "running");
    assert.equal(row?.dryRun, true);
    assert.equal(row?.actorId, "tester");
    assert.equal(row?.finishedAt, null);
  });

  it("omits the actor id rather than carrying a null through the context", async () => {
    const open = await openRun(db, {
      processKey: "test.anonymous",
      trigger: "cron",
      actor: { type: "system" },
      dryRun: false,
    });
    assert.deepEqual(open.context.actor, { type: "system" });
    assert.equal((await read(open.id))?.actorId, null);
  });

  it("closes the row with an outcome and a time", async () => {
    const open = await openRun(db, {
      processKey: "test.finish",
      trigger: "manual",
      actor: { type: "human", id: "someone" },
      dryRun: false,
    });
    await open.finish({ status: "partial", error: "two of five senders were over quota" });

    const row = await read(open.id);
    assert.equal(row?.status, "partial");
    assert.match(row?.error ?? "", /over quota/);
    assert.ok(row?.finishedAt instanceof Date);
  });

  it("keeps the first outcome when something finishes twice", async () => {
    const open = await openRun(db, {
      processKey: "test.twice",
      trigger: "cli",
      actor: { type: "system" },
      dryRun: false,
    });
    await open.finish({ status: "succeeded" });
    await open.finish({ status: "failed", error: "later confusion" });

    const row = await read(open.id);
    assert.equal(row?.status, "succeeded");
    assert.equal(row?.error, null);
  });
});

describe("withRun", { skip: url ? false : "TEST_DATABASE_URL is not set" }, () => {
  const input = (processKey: string) =>
    ({ processKey, trigger: "cli", actor: { type: "system" }, dryRun: false }) as const;

  it("closes a run that returns", async () => {
    let id = "";
    const value = await withRun(db, input("test.with.ok"), async (ctx) => {
      id = ctx.runId;
      return 42;
    });
    assert.equal(value, 42);
    assert.equal((await read(id))?.status, "succeeded");
  });

  it("records a throw as failed, and rethrows it", async () => {
    let id = "";
    await assert.rejects(
      withRun(db, input("test.with.throw"), async (ctx) => {
        id = ctx.runId;
        throw new Error("the provider said no");
      }),
      /the provider said no/,
    );
    const row = await read(id);
    assert.equal(row?.status, "failed");
    assert.match(row?.error ?? "", /the provider said no/);
  });

  it("records an abort as cancelled, because someone asked for it", async () => {
    const controller = new AbortController();
    let id = "";
    await assert.rejects(
      withRun(db, { ...input("test.with.abort"), signal: controller.signal }, async (ctx) => {
        id = ctx.runId;
        controller.abort();
        const error = new Error("stopped");
        error.name = "AbortError";
        throw error;
      }),
    );
    assert.equal((await read(id))?.status, "cancelled");
  });
});
