/**
 * The one reading by variant (decision 0072), against a migrated Postgres and
 * a metric source that records what it is asked: the number comes back with
 * the mark beside it, for an arm and for a correction alike.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallContext, MetricQuery, MetricSource } from "@werunfoundry/core/contracts/types";
import type { Database } from "@werunfoundry/core/runtime/run";

import { readByVariant } from "./variant-reading.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_variant_reading_${process.pid}`;
let admin: Client | undefined;
let client: Client;
let db: Database;
let experimentId: string;
const ctx: CallContext = { runId: "00000000-0000-4000-8000-000000000000", actor: { type: "human", id: "an operator" }, dryRun: false };

const asked: MetricQuery[] = [];
const source: MetricSource = {
  provider: "memory-metrics",
  metrics: ["acquisition.replied", "acquisition.bounced"],
  async read(query) {
    asked.push(query);
    return { ok: true, value: { key: query.key, applicable: true, value: query.params?.variant === "a" ? 4 : 7, asOf: "2026-10-27T09:00:00Z", source: "memory-metrics" } };
  },
};
const declarations = [
  { key: "acquisition.replied", unit: "people" },
  { key: "acquisition.bounced", unit: "people", channels: ["email"] },
];

describe("the one reading by variant (0072)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  before(async () => {
    admin = new Client({ connectionString: base });
    await admin.connect();
    await admin.query(`create database ${database}`);
    const url = new URL(base!);
    url.pathname = `/${database}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    for (const layer of ["../../../core", "../../relations", ".."]) {
      const dir = join(import.meta.dirname, layer, "db/migrations");
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(dir, f), "utf8"));
    }
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
    asked.length = 0;
    await client.query("truncate core.experiment cascade");
    [{ id: experimentId }] = (await client.query("insert into core.experiment (slug, type, hypothesis_ref) values ('spring', 'campaign', 'https://example.com/h') returning id")).rows;
    await client.query("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello')", [experimentId]);
    await client.query("insert into acquisition.template (experiment_id, variant, step, channel, body, corrects) values ($1, 'b', 1, 'email', 'Hello, fixed', 'a')", [experimentId]);
  });

  it("returns an arm's number with no correction beside it, and a correction's with the arm it corrects", async () => {
    const arm = await readByVariant({ db, source, declarations }, { experimentId, variant: "a", key: "acquisition.replied" }, ctx);
    const fix = await readByVariant({ db, source, declarations }, { experimentId, variant: "b", key: "acquisition.replied" }, ctx);
    assert.ok(arm.ok && fix.ok);
    assert.deepEqual([arm.value.variant, arm.value.corrects, arm.value.reading.applicable && arm.value.reading.value], ["a", null, 4]);
    assert.deepEqual([fix.value.variant, fix.value.corrects, fix.value.reading.applicable && fix.value.reading.value], ["b", "a", 7]);
    assert.deepEqual(asked.map((q) => q.params), [
      { experiment: "spring", variant: "a" },
      { experiment: "spring", variant: "b" },
    ]);
  });

  it("refuses a variant the experiment does not have, and asks the source nothing", async () => {
    const r = await readByVariant({ db, source, declarations }, { experimentId, variant: "z", key: "acquisition.replied" }, ctx);
    assert.ok(!r.ok && /has no variant "z"/.test(r.error.message));
    assert.equal(asked.length, 0);
  });

  it("keeps a metric that does not apply on the channel not applicable, the mark still beside it", async () => {
    const r = await readByVariant({ db, source, declarations }, { experimentId, variant: "b", key: "acquisition.bounced", channel: "social_message" }, ctx);
    assert.ok(r.ok);
    assert.deepEqual([r.value.reading.applicable, r.value.corrects], [false, "a"]);
    assert.equal(asked.length, 0);
  });
});
