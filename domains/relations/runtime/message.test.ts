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
import { Client, Pool } from "pg";

import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import { fingerprinter, fingerprintOf, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Database } from "@werunfoundry/core/runtime/run";

import type { MessageInput } from "./message.js";
import { writeMessage } from "./message.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_message_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;
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
  if (client) await client.query("truncate relations.message, relations.touch, relations.person, core.experiment, core.run cascade");
});

const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const aPerson = async (optedOut = false) =>
  (await rows("insert into relations.person (email, opted_out_at) values ('ada@example.com', $1) returning id", [optedOut ? new Date() : null]))[0].id as string;
const anExperiment = async (lane: string, status: string) =>
  (await rows("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values (gen_random_uuid()::text, 'campaign', 'https://example.com/h', $1, $2) returning id", [lane, status]))[0].id as string;

/** The register's reader, under one version whose secret is held (0055). */
const vocabulary = identityVocabulary([loadDomain(join(import.meta.dirname, "../domain.yaml")).manifest!]);
const SECRET = generateSecret();
const register = fingerprinter("T1", { T1: SECRET }, [], vocabulary);
/** The register refuses a truncate that would destroy an entry (0052); between tests, its triggers are set aside, as only a database's owner can. */
const forgetRegister = () => client.query("set session_replication_role = replica; truncate relations.suppression; set session_replication_role = origin");

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
    const first = await writeMessage(db, register, input(personId, { key: "k" }));
    assert.ok(first.ok && first.written);
    const again = await writeMessage(db, register, input(personId, { key: "k", body: "Different" }));
    assert.deepEqual(again, { ok: true, messageId: first.messageId, written: false });
    assert.deepEqual(await rows("select body from relations.message"), [{ body: "Hello" }]);
  });

  it("consent: refuses an opted-out person, even a solicited message from a person", async () => {
    assert.deepEqual(await refusal(writeMessage(db, register, input(await aPerson(true)))), ["consent: the person opted out"]);
  });

  it("consent: refuses a person the register holds an objection for, though no opt-out is on their row (0055)", async () => {
    const personId = await aPerson();
    await rows("insert into relations.suppression (fingerprint, chain, written_at) values ($1, '{T1}', now())", [fingerprintOf(SECRET, { kind: "email", value: "ada@example.com" }, vocabulary)]);
    try {
      assert.deepEqual(await refusal(writeMessage(db, register, input(personId))), ["consent: the person objected before an erasure, and the register holds it"]);
    } finally {
      await forgetRegister();
    }
  });

  it("consent: refuses while it cannot answer whether the person objected, and does not say they did (0055)", async () => {
    const lost = fingerprinter("T1", { T1: SECRET }, ["T0"], vocabulary);
    assert.deepEqual(await refusal(writeMessage(db, lost, input(await aPerson()))), ["consent: cannot answer whether the person objected — the register cannot be read: no secret is held for version T0 (decision 0063)"]);
  });

  it("cadence: counts concurrent writes to one person one after the other — the reader locks the person's row", async () => {
    const personId = await aPerson();
    const pool = new Pool({ connectionString: url, max: 8 });
    try {
      const many = drizzle(pool) as unknown as Database;
      const cap = { max: 1, withinDays: 30 };
      const results = await Promise.all(Array.from({ length: 8 }, () => writeMessage(many, register, input(personId, { unsolicited: true, cap }))));
      assert.equal(results.filter((r) => r.ok).length, 1, "concurrent writes each counted the cap before the others had written");
    } finally {
      await pool.end();
    }
  });

  it("cadence: judges no window behind for a message whose writer judged the cap ahead over its plan (0064 §3)", async () => {
    const personId = await aPerson();
    const cap = { max: 1, withinDays: 30 };
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap }))).ok);
    // Past the cap behind: refused as a message on its own…
    assert.match((await refusal(writeMessage(db, register, input(personId, { unsolicited: true, cap }))))[0]!, /^cadence: /);
    // …written as one step of a plan whose cap was judged ahead, with no other check lifted.
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cadence: "judged_ahead" }))).ok);
    await client.query("update relations.person set opted_out_at = now() where id = $1", [personId]);
    assert.deepEqual(await refusal(writeMessage(db, register, input(personId, { unsolicited: true, cadence: "judged_ahead" }))), ["consent: the person opted out"]);
  });

  it("cadence: refuses an unsolicited message with no cap", async () => {
    const [r] = await refusal(writeMessage(db, register, input(await aPerson(), { unsolicited: true })));
    assert.match(r!, /needs a cap/);
  });

  it("cadence: counts unsolicited messages inside the window, and never holds back a solicited one", async () => {
    const personId = await aPerson();
    const cap = { max: 2, withinDays: 10 };
    const day = (d: number) => new Date(Date.UTC(2026, 8, d));
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap }), day(1))).ok);
    // Out of the window by the time of the fourth: it no longer counts.
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap }), day(20))).ok);
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap }), day(25))).ok);
    const [r] = await refusal(writeMessage(db, register, input(personId, { unsolicited: true, cap }), day(26)));
    assert.match(r!, /2 unsolicited contacts with this person in 10 days, at a cap of 2/);
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: false }), day(26))).ok, "a solicited answer is held back");
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap }), day(40))).ok);
  });

  // Decision 0050: the cap reads touches. Each fixture leaves the cap as the
  // only rule that can refuse: a person, no opt-out, a person's write.
  const aTouch = (personId: string, over: Record<string, unknown> = {}) =>
    rows(
      `insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type, message_id)
       values ($1, 'email', $2, $3, 'a-sequencer', gen_random_uuid()::text, $4, 'system', $5)`,
      [personId, over.direction ?? "outbound", over.unsolicited ?? true, over.at ?? new Date(), over.messageId ?? null],
    );

  it("cadence: an unsolicited touch counts though no message was written — a send the sequencer made on its own", async () => {
    const personId = await aPerson();
    await aTouch(personId);
    const [r] = await refusal(writeMessage(db, register, input(personId, { unsolicited: true, cap: { max: 1, withinDays: 30 } })));
    assert.match(r!, /^cadence: 1 unsolicited contacts/);
  });

  it("cadence: an inbound touch, a solicited one, and one outside the window do not count", async () => {
    const personId = await aPerson();
    await aTouch(personId, { direction: "inbound", unsolicited: false });
    await aTouch(personId, { unsolicited: false });
    await aTouch(personId, { at: new Date(Date.now() - 40 * 86_400_000) });
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap: { max: 1, withinDays: 30 } }))).ok);
  });

  it("cadence: a message and the touch that confirms it count once; a message with no touch yet still counts", async () => {
    const personId = await aPerson();
    const cap = { max: 2, withinDays: 30 };
    const first = await writeMessage(db, register, input(personId, { unsolicited: true, cap }));
    assert.ok(first.ok);
    await aTouch(personId, { messageId: (first as { messageId: string }).messageId });
    // One contact so far, not two: a second passes.
    const second = await writeMessage(db, register, input(personId, { unsolicited: true, cap }));
    assert.ok(second.ok, "a message and its touch were counted twice");
    // The second is handed over and not confirmed: it counts, and the cap is reached.
    const [r] = await refusal(writeMessage(db, register, input(personId, { unsolicited: true, cap })));
    assert.match(r!, /^cadence: 2 unsolicited contacts/);
  });

  it("cadence: solicited messages do not count against the cap", async () => {
    const personId = await aPerson();
    for (let i = 0; i < 3; i++) assert.ok((await writeMessage(db, register, input(personId, { unsolicited: false }))).ok);
    assert.ok((await writeMessage(db, register, input(personId, { unsolicited: true, cap: { max: 1, withinDays: 30 } }))).ok);
  });

  it("lane: refuses an agent's message that names no approval, and takes a person's", async () => {
    const personId = await aPerson();
    const agent = { type: "agent" as const, id: "support-agent" };
    const [r] = await refusal(writeMessage(db, register, input(personId, { actor: agent })));
    assert.match(r!, /names who approved it/);
    assert.ok((await writeMessage(db, register, input(personId, { actor: agent, approvedBy: "an operator" }))).ok);
  });

  it("lane: an autonomous approval stands only for a running experiment whose lane is autonomous", async () => {
    const personId = await aPerson();
    const agent = { type: "agent" as const };
    const send = (experimentId?: string) => writeMessage(db, register, input(personId, { actor: agent, approvedBy: "lane:autonomous", ...(experimentId ? { experimentId } : {}) }));
    assert.ok((await send(await anExperiment("autonomous", "running"))).ok);
    assert.match((await refusal(send(await anExperiment("reviewed", "running"))))[0]!, /lane is reviewed/);
    assert.match((await refusal(send(await anExperiment("autonomous", "killed"))))[0]!, /killed, not running/);
    assert.match((await refusal(send()))[0]!, /needs the experiment/);
  });

  const reactive = async (opts: { lane?: string; status?: string; touched?: boolean } = {}) => {
    // Its own person each time: a test may set up more than one case.
    const [{ id: personId }] = await rows("insert into relations.person (email) values (gen_random_uuid()::text || '@example.com') returning id");
    const experimentId = await anExperiment(opts.lane ?? "reactive", opts.status ?? "running");
    if (opts.touched ?? true) {
      await client.query(
        "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'inbound', false, 'memory', gen_random_uuid()::text, now() - interval '5 minutes', 'system')",
        [personId],
      );
    }
    return (over: Partial<MessageInput> = {}) =>
      writeMessage(db, register, input(personId, { actor: { type: "agent" }, approvedBy: "lane:reactive", experimentId, reactiveWithinMinutes: 60, ...over }));
  };

  it("lane: a reactive approval stands on the person's inbound touch, on this channel, inside the window", async () => {
    assert.ok((await (await reactive())()).ok);
  });

  it("lane: a reactive approval is refused without the person's inbound touch on this channel", async () => {
    assert.match((await refusal((await reactive({ touched: false }))()))[0]!, /has not reached us on email in the last 60 minutes/);
    assert.match((await refusal((await reactive())({ channel: "social_message" })))[0]!, /has not reached us on social_message/);
  });

  it("lane: a reactive approval needs a window, with no default", async () => {
    assert.match((await refusal((await reactive())({ reactiveWithinMinutes: undefined })))[0]!, /needs a window/);
  });

  it("lane: a reactive approval needs a running experiment whose lane is reactive", async () => {
    assert.match((await refusal((await reactive({ lane: "reviewed" }))()))[0]!, /lane is reviewed, not reactive/);
    assert.match((await refusal((await reactive({ status: "killed" }))()))[0]!, /killed, not running/);
  });

  it("refuses all at once, and writes nothing", async () => {
    const refused = await refusal(writeMessage(db, register, input(await aPerson(true), { unsolicited: true, actor: { type: "system" } })));
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
    await writeMessage(db, register, input(personId, { runId }));
    await assert.rejects(client.query("update relations.message set body = 'rewritten'"), /append-only/);
    await client.query("delete from core.run where id = $1", [runId]);
    assert.deepEqual(await rows("select run_id from relations.message"), [{ run_id: null }]);
  });
});
