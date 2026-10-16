/**
 * Tests for writing a message and the gate it passes (decision 0038), against
 * a real database. Each refusal is isolated: the other two rules are met, so
 * only the rule under test can refuse.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import type { MessageInput } from "./message.js";
import { writeMessage } from "./message.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_message_${process.pid}`;
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
  for (const layer of ["../../../core", ".."]) {
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
  if (client) await client.query("truncate relations.message, relations.person, core.experiment, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aPerson = async (optedOut = false) =>
  (await rows("insert into relations.person (email, opted_out_at) values ('ada@example.com', $1) returning id", [optedOut ? new Date() : null]))[0].id as string;
const anExperiment = async (lane: string, status: string) =>
  (await rows("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values (gen_random_uuid()::text, 'campaign', 'https://example.com/h', $1, $2) returning id", [lane, status]))[0].id as string;

let n = 0;
const input = (personId: string, over: Partial<MessageInput> = {}): MessageInput => ({
  key: `send-${++n}`,
  personId,
  channel: "email",
  body: "Hello",
  unsolicited: false,
  actor: { type: "human", id: "an operator" },
  ...over,
});

const refusal = async (w: ReturnType<typeof writeMessage>) => {
  const r = await w;
  assert.equal(r.ok, false, "the message was written");
  return (r as { refused: string[] }).refused;
};

describe("writing a message", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("writes a lawful message once: the same key again is the same message", async () => {
    const personId = await aPerson();
    const first = await writeMessage(db, input(personId, { key: "k" }));
    assert.ok(first.ok && first.written);
    const again = await writeMessage(db, input(personId, { key: "k", body: "Different" }));
    assert.deepEqual(again, { ok: true, messageId: first.messageId, written: false });
    assert.deepEqual(await rows("select body from relations.message"), [{ body: "Hello" }]);
  });

  it("consent: refuses an opted-out person, even a solicited message from a person", async () => {
    assert.deepEqual(await refusal(writeMessage(db, input(await aPerson(true)))), ["consent: the person opted out"]);
  });

  it("cadence: refuses an unsolicited message with no cap", async () => {
    const [r] = await refusal(writeMessage(db, input(await aPerson(), { unsolicited: true })));
    assert.match(r!, /needs a cap/);
  });

  it("cadence: counts unsolicited messages inside the window, and never holds back a solicited one", async () => {
    const personId = await aPerson();
    const cap = { max: 2, withinDays: 10 };
    const day = (d: number) => new Date(Date.UTC(2026, 8, d));
    assert.ok((await writeMessage(db, input(personId, { unsolicited: true, cap }), day(1))).ok);
    // Out of the window by the time of the fourth: it no longer counts.
    assert.ok((await writeMessage(db, input(personId, { unsolicited: true, cap }), day(20))).ok);
    assert.ok((await writeMessage(db, input(personId, { unsolicited: true, cap }), day(25))).ok);
    const [r] = await refusal(writeMessage(db, input(personId, { unsolicited: true, cap }), day(26)));
    assert.match(r!, /2 unsolicited messages to this person in 10 days, at a cap of 2/);
    assert.ok((await writeMessage(db, input(personId, { unsolicited: false }), day(26))).ok, "a solicited answer is held back");
    assert.ok((await writeMessage(db, input(personId, { unsolicited: true, cap }), day(40))).ok);
  });

  it("cadence: solicited messages do not count against the cap", async () => {
    const personId = await aPerson();
    for (let i = 0; i < 3; i++) assert.ok((await writeMessage(db, input(personId, { unsolicited: false }))).ok);
    assert.ok((await writeMessage(db, input(personId, { unsolicited: true, cap: { max: 1, withinDays: 30 } }))).ok);
  });

  it("lane: refuses an agent's message that names no approval, and takes a person's", async () => {
    const personId = await aPerson();
    const agent = { type: "agent" as const, id: "support-agent" };
    const [r] = await refusal(writeMessage(db, input(personId, { actor: agent })));
    assert.match(r!, /names who approved it/);
    assert.ok((await writeMessage(db, input(personId, { actor: agent, approvedBy: "an operator" }))).ok);
  });

  it("lane: an autonomous approval stands only for a running experiment whose lane is autonomous", async () => {
    const personId = await aPerson();
    const agent = { type: "agent" as const };
    const send = (experimentId?: string) => writeMessage(db, input(personId, { actor: agent, approvedBy: "lane:autonomous", ...(experimentId ? { experimentId } : {}) }));
    assert.ok((await send(await anExperiment("autonomous", "running"))).ok);
    assert.match((await refusal(send(await anExperiment("reviewed", "running"))))[0]!, /lane is reviewed/);
    assert.match((await refusal(send(await anExperiment("autonomous", "killed"))))[0]!, /killed, not running/);
    assert.match((await refusal(send()))[0]!, /needs the experiment/);
  });

  it("lane: a reactive approval is refused until inbound can be verified", async () => {
    const experimentId = await anExperiment("reactive", "running");
    const [r] = await refusal(writeMessage(db, input(await aPerson(), { actor: { type: "agent" }, approvedBy: "lane:reactive", experimentId })));
    assert.match(r!, /reactive reply/);
  });

  it("refuses all at once, and writes nothing", async () => {
    const refused = await refusal(writeMessage(db, input(await aPerson(true), { unsolicited: true, actor: { type: "system" } })));
    assert.equal(refused.length, 3);
    assert.equal((await rows("select count(*)::int as n from relations.message"))[0].n, 0);
  });
});

describe("relations.message in the schema", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const insert = (personId: string, actor: string, approvedBy: string | null) =>
    client.query(
      "insert into relations.message (key, person_id, channel, body, unsolicited, approved_by, actor_type) values (gen_random_uuid()::text, $1, 'email', 'x', false, $3, $2)",
      [personId, actor, approvedBy],
    );

  it("refuses a message whose writer is not a person and which names no approval", async () => {
    const personId = await aPerson();
    await assert.rejects(insert(personId, "agent", null), /message_approved_check/);
    await insert(personId, "agent", "an operator");
    await insert(personId, "human", null);
  });

  it("keeps one message per key, whoever writes it", async () => {
    const personId = await aPerson();
    const write = () => client.query("insert into relations.message (key, person_id, channel, body, unsolicited, actor_type) values ('same', $1, 'email', 'x', false, 'human')", [personId]);
    await write();
    await assert.rejects(write(), /message_key_uidx/);
  });

  it("is append-only, and lets a deleted run take its attribution with it", async () => {
    const personId = await aPerson();
    const [{ id: runId }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', 'human') returning id");
    await writeMessage(db, input(personId, { runId }));
    await assert.rejects(client.query("update relations.message set body = 'rewritten'"), /append-only/);
    await client.query("delete from core.run where id = $1", [runId]);
    assert.deepEqual(await rows("select run_id from relations.message"), [{ run_id: null }]);
  });
});
