/**
 * Tests for acknowledging an uncovered customer (decision 0034), against a
 * real database: the acknowledgement is a person's act, recorded as its own
 * run, and the schema refuses anything else.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import { acknowledgeUncovered, readAcknowledged, withdrawAcknowledgement } from "./acknowledge.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_acknowledge_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  for (const layer of ["../../../core", "../../relations", ".."]) {
    const migrations = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(migrations, f), "utf8"));
    }
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
  if (client) await client.query("truncate acquisition.protection_acknowledgement, core.run cascade");
});

describe("acknowledging an uncovered customer", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("is a person's act, recorded as its own run with them as actor", async () => {
    const r = await acknowledgeUncovered(db, { customerId: "cust-z", note: "no domain upstream; reviewed by hand", by: "an operator" });
    assert.equal(r.acknowledged, true);
    const run = (await client.query("select process_key, actor_type, actor_id, status, dry_run from core.run where id = $1", [r.runId])).rows[0];
    assert.deepEqual(run, { process_key: "acquisition.protection.acknowledge", actor_type: "human", actor_id: "an operator", status: "succeeded", dry_run: false });
    assert.deepEqual([...(await readAcknowledged(db))], ["cust-z"]);
  });

  it("keeps one standing acknowledgement per customer", async () => {
    await acknowledgeUncovered(db, { customerId: "cust-z", note: "first", by: "an operator" });
    const again = await acknowledgeUncovered(db, { customerId: "cust-z", note: "second", by: "another operator" });
    assert.equal(again.acknowledged, false);
    assert.equal((await client.query("select count(*)::int as n from acquisition.protection_acknowledgement")).rows[0].n, 1);
  });

  it("is withdrawn by a person, and the history stays", async () => {
    await acknowledgeUncovered(db, { customerId: "cust-z", note: "for now", by: "an operator" });
    const w = await withdrawAcknowledgement(db, { customerId: "cust-z", by: "an operator" });
    assert.equal(w.withdrawn, true);
    assert.deepEqual([...(await readAcknowledged(db))], []);
    await acknowledgeUncovered(db, { customerId: "cust-z", note: "again", by: "an operator" });
    const rows = (await client.query("select note, withdrawn_at is not null as withdrawn from acquisition.protection_acknowledgement order by acknowledged_at")).rows;
    assert.deepEqual(rows, [{ note: "for now", withdrawn: true }, { note: "again", withdrawn: false }]);
  });

  it("refuses an acknowledgement without a person, a customer or a reason", async () => {
    await assert.rejects(acknowledgeUncovered(db, { customerId: "cust-z", note: "why", by: " " }), /who acknowledges is required/);
    await assert.rejects(acknowledgeUncovered(db, { customerId: "cust-z", note: "", by: "an operator" }), /the reason is required/);
  });

  it("is refused by the schema when its actor is not a person", async () => {
    const { rows } = await client.query("insert into core.run (process_key, trigger, actor_type) values ('x', 'cli', 'system') returning id");
    await assert.rejects(
      client.query("insert into acquisition.protection_acknowledgement (customer_id, note, actor_type, actor_id, run_id) values ('cust-z', 'why', 'system', 'a job', $1)", [rows[0].id]),
      /protection_acknowledgement_human_check/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* No run writes an acknowledgement                                            */
/* -------------------------------------------------------------------------- */

describe("the runs", () => {
  const read = (path: string) => readFileSync(join(import.meta.dirname, path), "utf8");
  // Every file a run is made of, that reads protection.
  const runs = ["./enrol.ts", "./source.ts", "./protection.ts", "../bin/enrol.ts", "../bin/source.ts"];

  it("read the acknowledged set and never write it", () => {
    for (const path of runs) {
      const text = read(path);
      assert.ok(!/acknowledgeUncovered|withdrawAcknowledgement|protectionAcknowledgement/.test(text), `${path} reaches the acknowledgement's writers or its table`);
      const imports = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/acknowledge\.js"/g)].flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
      assert.ok(imports.every((name) => name === "readAcknowledged"), `${path} imports ${imports.join(", ")} from the acknowledgement module`);
    }
  });
});
