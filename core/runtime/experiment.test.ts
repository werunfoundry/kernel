/**
 * Recording and starting an experiment (decision 0072), against a migrated
 * Postgres. The domain's say on a start is a function here: what it answers,
 * with the row locked, is what the start does.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { recordExperiment, startExperiment } from "./experiment.js";
import type { Database } from "./run.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_experiment_${process.pid}`;
let admin: Client | undefined;
let client: Client;
let db: Database;
const rows = async (sql: string) => (await client.query(sql)).rows;
const types = new Set(["campaign"]);
const spring = { slug: "spring", type: "campaign", hypothesisRef: "https://example.com/h/1", lane: "reviewed" as const, by: "an operator", trigger: "cli" as const };

describe("an experiment, recorded then started by a person (0072)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  before(async () => {
    admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(base!);
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    const dir = join(import.meta.dirname, "../db/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(dir, f), "utf8"));
    db = drizzle(client) as unknown as Database;
  });

  after(async () => {
    await client?.end();
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await client.query("truncate core.experiment, core.run cascade");
  });

  it("records in draft, and refuses an undeclared type and a slug on record", async () => {
    assert.ok("runId" in (await recordExperiment(db, spring, types)));
    assert.deepEqual(await recordExperiment(db, { ...spring, type: "raffle" }, types), { refused: 'no enabled domain declares the experiment type "raffle"; declared: campaign' });
    assert.deepEqual(await recordExperiment(db, spring, types), { refused: "an experiment spring is already on record" });
    assert.deepEqual(await rows("select status, lane from core.experiment"), [{ status: "draft", lane: "reviewed" }]);
  });

  it("starts only when the domain says it is ready, and only from draft", async () => {
    await recordExperiment(db, spring, types);
    const notReady = await startExperiment(db, spring, async () => "it has no template");
    assert.deepEqual(notReady, { refused: "it has no template" });
    assert.deepEqual(await rows("select status from core.experiment"), [{ status: "draft" }]);

    assert.ok("runId" in (await startExperiment(db, spring, async () => undefined)));
    assert.deepEqual(await rows("select status from core.experiment"), [{ status: "running" }]);
    assert.deepEqual(await startExperiment(db, spring, async () => undefined), { refused: "the experiment is running: only one in draft is started" });
    assert.deepEqual(await rows("select process_key, status from core.run order by started_at"), [
      { process_key: "core.experiment.record", status: "succeeded" },
      { process_key: "core.experiment.start", status: "failed" },
      { process_key: "core.experiment.start", status: "succeeded" },
      { process_key: "core.experiment.start", status: "failed" },
    ]);
  });
});
