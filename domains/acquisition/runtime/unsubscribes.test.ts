/**
 * The unsubscribes pull (0051's verb 4), against a real Postgres: every
 * write it makes goes through the core's and relations' own write paths, and
 * an opt-out ends at the sequencer, as the inbound pull's does.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { identityVocabulary } from "@werunfoundry/core/identity";
import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";

import type { InboundEvent } from "../contracts/inbound.js";
import { pullUnsubscribes } from "./unsubscribes.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_unsubscribes_${process.pid}`;
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

const relations = loadDomain(join(import.meta.dirname, "../../relations/domain.yaml")).manifest!;
const identity = identityVocabulary([relations]);
const declared = {
  eventTypes: new Set(["acquisition.reply", "acquisition.unsubscribe", "acquisition.meeting_booked"]),
  channels: new Set(["email"]),
};
const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

const unsubscribe = (id: string, email: string, type = "acquisition.unsubscribe"): InboundEvent => ({
  providerEventId: id,
  type,
  occurredAt: "2026-10-20T10:00:00Z",
  subject: { subject: "person", keys: [{ kind: "email", value: email }] },
  attribution: { sequenceKey: "welcome", channel: "email" },
});

/**
 * A sequencer that holds enrolments by their key and the unsubscribes it is
 * given. What it answers to the pull is set per test.
 */
const held = new Map<string, string>();
let answer: { items: InboundEvent[]; complete: boolean } | "down" = { items: [], complete: true };
let withdrawDown = false;
const sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  declares: {
    enrol: { serves: "no", why: "this double does not enrol" },
    pullTouches: { serves: "no", why: "not in this test" },
    suspend: { serves: "yes", method: "letting go of the person", costs: { person: [], sequence: [] }, gap: { known: true, minutes: 0, basis: "by construction", measuredOn: "2026-10-21" } },
    pullUnsubscribes: { serves: "yes" },
  },
  pulled: 0,
  async pullUnsubscribes() {
    this.pulled++;
    if (answer === "down") return { ok: false, error: { code: "unavailable", message: "the sequencer did not answer", retryable: true } };
    return { ok: true, value: answer };
  },
  async withdraw({ idempotencyKey, sequenceKey }: { idempotencyKey: string; sequenceKey: string }, ctx: { dryRun: boolean }) {
    const asOf = new Date().toISOString();
    if (withdrawDown) return { ok: false, error: { code: "unavailable", message: "the sequencer did not answer", retryable: true } };
    if (!held.has(idempotencyKey)) return { ok: true, value: { found: false, asOf } };
    if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, asOf } };
    held.delete(idempotencyKey);
    return { ok: true, value: { found: true, readBack: { sequenceKey, held: false }, asOf } };
  },
};

/** One that declares the verb not served, and would be wrong to call. */
const silent = {
  ...sequencer,
  provider: "silent-sequencer",
  declares: { ...sequencer.declares, pullUnsubscribes: { serves: "no", why: "not built" } },
  async pullUnsubscribes() {
    throw new Error("a sequencer that does not serve the unsubscribes pull was pulled");
  },
};

const registryOf = (...sequencers: unknown[]) =>
  ({
    all: (contract: string) => (contract === "sequencer" ? sequencers : []),
    forChannel: (contract: string, channel: string) => (contract === "sequencer" && channel === "email" ? sequencer : undefined),
  }) as unknown as Registry;

const pull = (over: { dryRun?: boolean; sequencers?: unknown[] } = {}) =>
  pullUnsubscribes(
    { db, registry: registryOf(...(over.sequencers ?? [sequencer])), identity, declared },
    { dryRun: over.dryRun ?? false, actor: { type: "system" }, trigger: "cli" },
  );

/** Ada, recorded and enrolled in `welcome` through the memory sequencer, which holds her. */
async function enrolledAda(): Promise<string> {
  const [{ id }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
  await client.query("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type) values ($1, 'welcome', 'email', 'key-ada', 'enrolled', 'memory-sequencer', 'system')", [id]);
  held.set("key-ada", "welcome");
  return id;
}
const optedOut = async () => (await rows("select email, opted_out_at from relations.person where opted_out_at is not null order by email")).map((r) => [r.email, r.opted_out_at.toISOString()]);
const enrolmentState = async () => (await rows("select state from acquisition.enrolment"))[0]?.state;
const lastRun = async () => (await rows("select process_key, status, error from core.run order by started_at desc limit 1"))[0];

describe("pulling a sequencer's unsubscribes (0051, verb 4)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(async () => {
    await client.query("truncate core.event, relations.touch, relations.person, core.run cascade");
    held.clear();
    withdrawDown = false;
    sequencer.pulled = 0;
    answer = { items: [], complete: true };
  });

  it("stores each unsubscribe once, opts out whoever is recorded, and stops their running enrolments", async () => {
    await enrolledAda();
    answer = { items: [unsubscribe("u1", "ada@example.com"), unsubscribe("u2", "nobody@example.com")], complete: true };
    const [r] = await pull();
    assert.equal(r!.stoppedBy, undefined);
    assert.deepEqual([r!.read, r!.recorded, r!.replayed, r!.optOuts, r!.unknownPeople], [2, 2, 0, 1, 1]);
    assert.deepEqual(await optedOut(), [["ada@example.com", "2026-10-20T10:00:00.000Z"]]);
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 1, "a person was created from an event");
    assert.deepEqual(r!.stopped, { suspended: 1, notHeld: 0, byAddress: 0, would: 0 });
    assert.equal(await enrolmentState(), "suspended");
    assert.deepEqual(await lastRun(), { process_key: "acquisition.unsubscribes.memory-sequencer", status: "succeeded", error: null });
  });

  it("writes no touch: an unsubscribe is not the person reaching us (0042)", async () => {
    await enrolledAda();
    answer = { items: [unsubscribe("u1", "ada@example.com")], complete: true };
    await pull();
    assert.equal((await rows("select count(*)::int as n from relations.touch"))[0].n, 0);
  });

  it("reads them all again each time, and counts what it already stored as replayed", async () => {
    await enrolledAda();
    answer = { items: [unsubscribe("u1", "ada@example.com")], complete: true };
    await pull();
    const [again] = await pull();
    assert.deepEqual([again!.read, again!.recorded, again!.replayed, again!.optOuts], [1, 0, 1, 0]);
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 1);
  });

  it("stores nothing of a read that carries another kind of event, and says which", async () => {
    await enrolledAda();
    answer = { items: [unsubscribe("u1", "ada@example.com"), unsubscribe("r1", "ada@example.com", "acquisition.reply")], complete: true };
    const [r] = await pull();
    assert.match(r!.stoppedBy!, /event r1 refused, nothing stored: type: the unsubscribes pull returned "acquisition.reply"/);
    assert.deepEqual(await optedOut(), []);
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 0);
    assert.equal((await lastRun()).status, "failed");
  });

  it("stores nothing of a read with an event that fails its check", async () => {
    answer = { items: [unsubscribe("u1", "ada@example.com"), { ...unsubscribe("u2", "eve@example.com"), occurredAt: "not a date" }], complete: true };
    const [r] = await pull();
    assert.match(r!.stoppedBy!, /event u2 refused, nothing stored/);
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 0);
  });

  it("keeps what a partial read gave, and says the run read only part", async () => {
    await enrolledAda();
    answer = { items: [unsubscribe("u1", "ada@example.com")], complete: false };
    const [r] = await pull();
    assert.match(r!.stoppedBy!, /read only part of its unsubscribes/);
    assert.deepEqual(await optedOut(), [["ada@example.com", "2026-10-20T10:00:00.000Z"]]);
    assert.equal(await enrolmentState(), "suspended");
    assert.equal((await lastRun()).status, "partial");
  });

  it("fails the run when the sequencer cannot be read, and stores nothing", async () => {
    answer = "down";
    const [r] = await pull();
    assert.match(r!.stoppedBy!, /could not be read: unavailable/);
    assert.equal((await lastRun()).status, "failed");
  });

  it("keeps the opt-out when the suspension fails, and says the next pull tries again", async () => {
    await enrolledAda();
    withdrawDown = true;
    answer = { items: [unsubscribe("u1", "ada@example.com")], complete: true };
    const [r] = await pull();
    assert.match(r!.stoppedBy!, /could not be stopped at their provider; the next pull tries again/);
    assert.deepEqual(await optedOut(), [["ada@example.com", "2026-10-20T10:00:00.000Z"]]);
    assert.equal(await enrolmentState(), "enrolled");
    assert.equal((await lastRun()).status, "partial");
  });

  it("in a dry run, reads and checks, says whom it would stop, and writes nothing", async () => {
    const id = await enrolledAda();
    await client.query("update relations.person set opted_out_at = now() where id = $1", [id]);
    answer = { items: [unsubscribe("u1", "eve@example.com")], complete: true };
    const [r] = await pull({ dryRun: true });
    assert.deepEqual([r!.read, r!.recorded], [1, 0]);
    assert.equal(r!.stopped.would, 1);
    assert.equal((await rows("select count(*)::int as n from core.event"))[0].n, 0);
    assert.equal(held.size, 1);
  });

  it("fails, and does not pull, a sequencer that declares the verb served without the method (0054)", async () => {
    const { pullUnsubscribes: _, ...methodless } = sequencer;
    const [r] = await pull({ sequencers: [{ ...methodless, provider: "methodless" }] });
    assert.match(r!.stoppedBy!, /declares itself in a form the kernel cannot read, so nothing was pulled: .*pullUnsubscribes/);
    assert.deepEqual(await lastRun(), { process_key: "acquisition.unsubscribes.methodless", status: "failed", error: r!.stoppedBy });
  });

  it("does not pull a sequencer that declares the verb not served", async () => {
    const reports = await pull({ sequencers: [silent, sequencer] });
    assert.deepEqual(reports.map((r) => r.provider), ["memory-sequencer"]);
    assert.equal(sequencer.pulled, 1);
  });
});
