/**
 * Tests for the inbound pull (decision 0039), against a real database and an
 * in-memory source. The source is injected here; the pull through a bound
 * adapter, from the packs, on plain Node, is `scripts/try-instance.mjs`.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { CallResult } from "@werunfoundry/core/contracts/types";
import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";

import type { Inbound, InboundEvent, InboundPage } from "../contracts/inbound.js";
import { pullInbound } from "./inbound.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_inbound_${process.pid}`;
let admin: Client;
let client: Client;
let db: Database;

const urlOf = () => {
  const url = new URL(base!);
  url.pathname = `/${database}`;
  return url.toString();
};

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  client = new Client({ connectionString: urlOf() });
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
  if (client) await client.query("truncate core.event, acquisition.inbound_cursor, relations.touch, relations.person, core.run cascade");
});

const relations = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!;
const identity = identityVocabulary([relations]);
const declared = {
  eventTypes: new Set(["acquisition.reply", "acquisition.unsubscribe", "acquisition.meeting_booked"]),
  channels: new Set(["email"]),
};
const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

const ev = (id: string, type: string, email: string, channel?: string): InboundEvent => ({
  providerEventId: id,
  type,
  occurredAt: "2026-09-01T10:00:00Z",
  subject: { subject: "person", keys: [{ kind: "email", value: email }] },
  ...(channel ? { attribution: { channel } } : {}),
});

/** A source over a fixed list, the cursor being a position; it records what it was asked. */
function memory(events: InboundEvent[], opts: { failAfter?: number; delayMs?: number } = {}) {
  const asked: (string | undefined)[] = [];
  const source: Inbound & { asked: typeof asked } = {
    provider: "memory",
    eventTypes: ["acquisition.reply", "acquisition.unsubscribe", "acquisition.meeting_booked"],
    asked,
    async events({ after, limit }): Promise<CallResult<InboundPage>> {
      asked.push(after);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const start = Number(after ?? 0);
      if (opts.failAfter !== undefined && start >= opts.failAfter) return { ok: false, error: { code: "unavailable", message: "down", retryable: true } };
      const items = events.slice(start, start + (limit ?? 100));
      return { ok: true, value: { items, cursor: String(start + items.length) } };
    },
  };
  return source;
}

/**
 * The sequencer an opt-out is applied through (0051): it holds enrolments by
 * their key, lets go of one it withdraws and reads that back — or does not
 * answer.
 */
const held = new Map<string, string>();
let sequencerDown = false;
const sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  declares: {
    enrol: { serves: "no", why: "this double does not enrol" },
    pullTouches: { serves: "no", why: "not in this test" },
    suspend: { serves: "yes", method: "letting go of the person", costs: { person: [], sequence: [] }, gap: { known: true, minutes: 0, basis: "by construction", measuredOn: "2026-10-21" } },
    pullUnsubscribes: { serves: "no", why: "not in this test" },
  },
  async withdraw({ idempotencyKey, sequenceKey }: { idempotencyKey: string; sequenceKey: string }, ctx: { dryRun: boolean }) {
    const asOf = new Date().toISOString();
    if (sequencerDown) return { ok: false, error: { code: "unavailable", message: "the sequencer did not answer", retryable: true } };
    if (!held.has(idempotencyKey)) return { ok: true, value: { found: false, asOf } };
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, asOf } };
    held.delete(idempotencyKey);
    return { ok: true, value: { found: true, readBack: { sequenceKey, held: false }, asOf } };
  },
};

const registryOf = (...sources: Inbound[]) =>
  ({
    list: () => sources.map((adapter, index) => ({ contract: "inbound", specifier: "memory", provider: adapter.provider, adapter, channels: [], finds: [], index })),
    forChannel: (contract: string, channel: string) => (contract === "sequencer" && channel === "email" ? sequencer : undefined),
  }) as unknown as Registry;

const pull = (source: Inbound, over: { dryRun?: boolean; maxPages?: number; pageSize?: number; on?: Database } = {}) =>
  pullInbound(
    { db: over.on ?? db, registry: registryOf(source), identity, declared },
    { dryRun: over.dryRun ?? false, actor: { type: "system" }, trigger: "cli", maxPages: over.maxPages ?? 10, pageSize: over.pageSize ?? 2 },
  );

describe("an opt-out, applied at the sequencer (0051)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(() => {
    held.clear();
    sequencerDown = false;
  });
  /** Ada, enrolled in `welcome` through the memory sequencer, which holds her. */
  async function enrolledAda(): Promise<string> {
    const [{ id }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    await client.query("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'key-ada', 'enrolled', 'memory-sequencer', 'system')", [id]);
    held.set("key-ada", "welcome");
    return id;
  }
  const state = async () => (await rows("select state, suspension_read_back from acquisition.enrolment"))[0];

  it("suspends the running enrolments of whoever unsubscribed, once the page is stored", async () => {
    await enrolledAda();
    const [r] = await pull(memory([ev("u1", "acquisition.unsubscribe", "ada@example.com", "email")]));
    assert.equal(r!.stoppedBy, undefined);
    assert.deepEqual(r!.stopped, { suspended: 1, notHeld: 0, byAddress: 0, would: 0 });
    assert.deepEqual(await state(), { state: "suspended", suspension_read_back: { sequenceKey: "welcome", held: false } });
    assert.equal(held.size, 0, "the sequencer still holds someone who asked to stop");
  });

  it("says so when the sequencer does not answer, and the next pull stops them without the event again", async () => {
    await enrolledAda();
    sequencerDown = true;
    const [first] = await pull(memory([ev("u1", "acquisition.unsubscribe", "ada@example.com", "email")]));
    assert.match(first!.stoppedBy!, /people who opted out could not be stopped at their provider; the next pull tries again/);
    assert.equal((await state()).state, "enrolled");
    sequencerDown = false;
    const [second] = await pull(memory([ev("u1", "acquisition.unsubscribe", "ada@example.com", "email")]));
    assert.equal(second!.read, 0, "the second pull read the event again");
    assert.deepEqual(second!.stopped, { suspended: 1, notHeld: 0, byAddress: 0, would: 0 });
    assert.equal((await state()).state, "suspended");
  });

  it("on a dry run, says whom it would stop, and stops nobody", async () => {
    const id = await enrolledAda();
    await client.query("update relations.person set opted_out_at = now() where id = $1", [id]);
    const [r] = await pull(memory([]), { dryRun: true });
    assert.deepEqual(r!.stopped, { suspended: 0, notHeld: 0, byAddress: 0, would: 1 });
    assert.equal((await state()).state, "enrolled");
    assert.equal(held.size, 1);
  });
});

describe("pulling inbound", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("stores every event once, ties it to a recorded person, applies an opt-out, and advances the cursor", async () => {
    const [{ id: ada }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
    const source = memory([
      ev("r1", "acquisition.reply", "ada@example.com", "email"),
      ev("m1", "acquisition.meeting_booked", "ada@example.com"),
      ev("u1", "acquisition.unsubscribe", "ada@example.com", "email"),
      ev("r2", "acquisition.reply", "nobody@example.org", "email"),
    ]);
    const [r] = await pull(source);
    assert.deepEqual({ ...r, runId: undefined }, { provider: "memory", runId: undefined, pages: 3, read: 4, recorded: 4, replayed: 0, touches: 2, optOuts: 1, unknownPeople: 1, stopped: { suspended: 0, notHeld: 0, byAddress: 0, would: 0 }, cursor: "4" });
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 4);
    assert.deepEqual(await rows("select provider_event_id as id, direction::text from relations.touch order by 1"), [{ id: "r1", direction: "inbound" }, { id: "u1", direction: "inbound" }]);
    assert.ok((await rows("select opted_out_at from relations.person where id = $1", [ada]))[0].opted_out_at instanceof Date);
    assert.deepEqual(await rows("select cursor from acquisition.inbound_cursor"), [{ cursor: "4" }]);

    const [again] = await pull(source);
    assert.equal(again!.recorded, 0);
    assert.deepEqual(source.asked.slice(-1), ["4"]);
  });

  it("stops at an event that fails its check, stores nothing of its page, and leaves the cursor before it", async () => {
    const source = memory([ev("r1", "acquisition.reply", "a@example.com"), ev("r2", "acquisition.reply", "b@example.com"), ev("x", "acquisition.undeclared", "c@example.com"), ev("r3", "acquisition.reply", "d@example.com")]);
    const [r] = await pull(source);
    assert.match(r!.stoppedBy!, /event x refused.*no enabled domain declares/);
    assert.deepEqual(await rows("select provider_event_id as id from core.event order by 1"), [{ id: "r1" }, { id: "r2" }]);
    assert.deepEqual(await rows("select cursor from acquisition.inbound_cursor"), [{ cursor: "2" }]);
    assert.equal((await rows("select status from core.run where id = $1", [r!.runId]))[0].status, "partial");
  });

  it("stops when the source cannot be read, and the cursor stays where the last stored page left it", async () => {
    const [r] = await pull(memory([ev("r1", "acquisition.reply", "a@example.com"), ev("r2", "acquisition.reply", "b@example.com"), ev("r3", "acquisition.reply", "c@example.com")], { failAfter: 2 }));
    assert.match(r!.stoppedBy!, /could not be read: unavailable/);
    assert.deepEqual(await rows("select cursor from acquisition.inbound_cursor"), [{ cursor: "2" }]);
  });

  it("writes nothing in a dry run — not the cursor either", async () => {
    const [r] = await pull(memory([ev("r1", "acquisition.reply", "a@example.com")]), { dryRun: true });
    assert.equal(r!.read, 1);
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 0);
    assert.equal((await rows("select count(*)::int as n from acquisition.inbound_cursor"))[0].n, 0);
    assert.equal((await rows("select dry_run from core.run where id = $1", [r!.runId]))[0].dry_run, true);
  });

  it("has one writer per source: a second pull waits, then reads after the first", async () => {
    const other = new Client({ connectionString: urlOf() });
    await other.connect();
    try {
      // The row exists already, so only its lock can serialise the two: a first
      // insert of it would make the second wait on the key instead.
      await client.query("insert into acquisition.inbound_cursor (provider) values ('memory')");
      const source = memory([ev("r1", "acquisition.reply", "a@example.com"), ev("r2", "acquisition.reply", "b@example.com")], { delayMs: 150 });
      await Promise.all([pull(source, { maxPages: 1 }), pull(source, { maxPages: 1, on: drizzle(other) as unknown as Database })]);
      assert.deepEqual([...source.asked].sort(), ["2", undefined].sort());
    } finally {
      await other.end();
    }
  });

  it("refuses a pull with no page budget, and a source bound twice under one name", async () => {
    await assert.rejects(pull(memory([]), { maxPages: 0 }), /maxPages is required/);
    const a = memory([]);
    await assert.rejects(
      pullInbound({ db, registry: registryOf(a, a), identity, declared }, { dryRun: true, actor: { type: "system" }, trigger: "cli", maxPages: 1 }),
      /bound twice/,
    );
  });
});
