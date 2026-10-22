/**
 * The touches pull (0051's verb 2, 0064 §5), against a real Postgres: each
 * send a sequencer reports becomes one outbound touch, tied to the message
 * its enrolment's plan names for that step.
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
import { fingerprinter, generateSecret } from "@werunfoundry/core/runtime/fingerprint";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { Database } from "@werunfoundry/core/runtime/run";
import { writeMessage } from "@werunfoundry/relations/runtime/message";

import type { SentStep, TouchesPage } from "../contracts/sequencer.js";
import { pullTouches, touchesCursorOf } from "./touches.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_touches_${process.pid}`;
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
const register = fingerprinter("T1", { T1: generateSecret() }, [], identity);
const declared = { eventTypes: new Set<string>(), channels: new Set(["email"]) };
const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

/** A sequencer that reports the sends it is given, and remembers the cursors it was asked after. */
let answer: TouchesPage | "down" = { items: [], complete: true };
const askedAfter: (string | undefined)[] = [];
const sequencer = {
  provider: "memory-sequencer",
  channels: ["email"],
  declares: {
    enrol: { serves: "yes" },
    pullTouches: { serves: "yes" },
    suspend: { serves: "yes", method: "letting go", costs: { person: [], sequence: [] }, gap: { known: true, minutes: 0, basis: "by construction", measuredOn: "2026-10-22" } },
    pullUnsubscribes: { serves: "no", why: "not in this test" },
  },
  async enrol() {
    throw new Error("not in this test");
  },
  async withdraw() {
    throw new Error("not in this test");
  },
  async pullTouches({ after }: { after?: string }): Promise<CallResult<TouchesPage>> {
    askedAfter.push(after);
    if (answer === "down") return { ok: false, error: { code: "unavailable", message: "the sequencer did not answer", retryable: true } };
    return { ok: true, value: answer };
  },
};
const silent = { ...sequencer, provider: "silent", declares: { ...sequencer.declares, pullTouches: { serves: "no", why: "not built" } }, async pullTouches(): Promise<never> {
  throw new Error("a sequencer that does not serve the touches pull was pulled");
} };
const registryOf = (...sequencers: unknown[]) => ({ all: (c: string) => (c === "sequencer" ? sequencers : []) }) as unknown as Registry;
const pull = (over: { dryRun?: boolean; sequencers?: unknown[] } = {}) =>
  pullTouches({ db, registry: registryOf(...(over.sequencers ?? [sequencer])), identity, declared }, { dryRun: over.dryRun ?? false, actor: { type: "system" }, trigger: "cli" });

const send = (id: string, email: string, over: Partial<SentStep> = {}): SentStep => ({
  providerEventId: id,
  sequenceKey: "welcome",
  step: 1,
  person: { subject: "person", keys: [{ kind: "email", value: email }] },
  channel: "email",
  occurredAt: "2026-10-22T10:00:00.000Z",
  ...over,
});

/** Ada, enrolled in `welcome` carrying one message per step, the first unsolicited, the second not. */
async function enrolledAda() {
  const { id: personId } = await one("insert into relations.person (email) values ('ada@example.com') returning id");
  const { id: experimentId } = await one("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('exp', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id");
  const ids: string[] = [];
  for (const [i, unsolicited] of [true, false].entries()) {
    const w = await writeMessage(db, register, { key: `m${i}`, personId, channel: "email", body: `Step ${i + 1}`, unsolicited, ...(unsolicited ? { cap: { max: 5, withinDays: 30 } } : {}), experimentId, actor: { type: "human", id: "an operator" } });
    assert.ok(w.ok, JSON.stringify(w));
    ids.push(w.messageId);
  }
  const plan = [
    { step: 1, afterPreviousMinutes: 0, messageId: ids[0], unsolicited: true },
    { step: 2, afterPreviousMinutes: 4320, messageId: ids[1], unsolicited: false },
  ];
  await client.query("insert into acquisition.enrolment (person_id, sequence_key, channel, idempotency_key, state, provider, actor_type, plan) values ($1, 'welcome', 'email', 'k-ada', 'enrolled', 'memory-sequencer', 'system', $2)", [personId, JSON.stringify(plan)]);
  return { personId, experimentId, messages: ids };
}
const touches = () => rows("select provider_event_id, unsolicited, message_id, experiment_id, direction from relations.touch order by provider_event_id");

describe("pulling a sequencer's sends (0051, verb 2)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  beforeEach(async () => {
    await client.query("truncate relations.touch, relations.message, relations.person, acquisition.enrolment, acquisition.inbound_cursor, core.experiment, core.run cascade");
    answer = { items: [], complete: true };
    askedAfter.length = 0;
  });

  it("records each send as an outbound touch, tied to the message the enrolment's plan names for its step", async () => {
    const { experimentId, messages } = await enrolledAda();
    answer = { items: [send("s1", "ada@example.com"), send("s2", "ada@example.com", { step: 2 })], cursor: "2026-10-22T10:00:00.000Z", complete: true };
    const [r] = await pull();
    assert.equal(r!.stoppedBy, undefined);
    assert.deepEqual([r!.read, r!.recorded, r!.matched], [2, 2, 2]);
    assert.deepEqual(await touches(), [
      { provider_event_id: "s1", unsolicited: true, message_id: messages[0], experiment_id: experimentId, direction: "outbound" },
      { provider_event_id: "s2", unsolicited: false, message_id: messages[1], experiment_id: experimentId, direction: "outbound" },
    ]);
  });

  it("records a send no plan names as unsolicited, tied to no message: the cap errs toward refusing", async () => {
    await enrolledAda();
    await client.query("insert into relations.person (email) values ('bo@example.com')");
    answer = { items: [send("x1", "ada@example.com", { step: 3 }), send("x2", "ada@example.com", { sequenceKey: "other" }), send("x3", "bo@example.com"), send("x4", "ada@example.com", { step: undefined })], complete: true };
    const [r] = await pull();
    assert.deepEqual([r!.recorded, r!.matched], [4, 0]);
    assert.deepEqual((await touches()).map((t) => [t.provider_event_id, t.unsolicited, t.message_id]), [["x1", true, null], ["x2", true, null], ["x3", true, null], ["x4", true, null]]);
  });

  it("stores its cursor with the touches, reads after it next time, and counts a send read again as replayed", async () => {
    await enrolledAda();
    answer = { items: [send("s1", "ada@example.com")], cursor: "2026-10-22T10:00:00.000Z", complete: true };
    await pull();
    assert.equal((await one("select cursor from acquisition.inbound_cursor where provider = $1", [touchesCursorOf("memory-sequencer")])).cursor, "2026-10-22T10:00:00.000Z");
    const [again] = await pull();
    assert.deepEqual(askedAfter, [undefined, "2026-10-22T10:00:00.000Z"]);
    assert.deepEqual([again!.recorded, again!.replayed], [0, 1]);
    assert.equal((await touches()).length, 1);
  });

  it("counts a send to someone not on record, and writes nothing for them", async () => {
    answer = { items: [send("n1", "nobody@example.com")], complete: true };
    const [r] = await pull();
    assert.deepEqual([r!.unknownPeople, r!.recorded], [1, 0]);
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 0);
  });

  it("stores nothing of a read with a send that fails its check, and keeps the cursor where it was", async () => {
    await enrolledAda();
    answer = { items: [send("s1", "ada@example.com"), send("bad", "ada@example.com", { channel: "fax" })], cursor: "2026-10-22T11:00:00.000Z", complete: true };
    const [r] = await pull();
    assert.match(r!.stoppedBy ?? "", /send bad refused, nothing stored: "fax" is not a declared channel/);
    answer = { items: [send("t1", "ada@example.com", { occurredAt: "soon" })], complete: true };
    const [r2] = await pull();
    assert.match(r2!.stoppedBy ?? "", /"soon" is not a time/);
    assert.equal((await touches()).length, 0);
    assert.equal((await rows("select count(*)::int as n from acquisition.inbound_cursor"))[0].n, 0);
  });

  it("keeps what a partial read gave, moves its cursor, and says the run read only part", async () => {
    await enrolledAda();
    answer = { items: [send("s1", "ada@example.com")], cursor: "2026-10-22T10:00:00.000Z", complete: false };
    const [r] = await pull();
    assert.match(r!.stoppedBy ?? "", /read only part of its sends/);
    assert.equal((await touches()).length, 1);
    assert.equal((await one("select status from core.run where id = $1", [r!.runId])).status, "partial");
  });

  it("fails the run when the sequencer cannot be read", async () => {
    answer = "down";
    const [r] = await pull();
    assert.match(r!.stoppedBy ?? "", /could not be read: unavailable/);
  });

  it("in a dry run, reads and checks, and writes nothing — not the cursor either", async () => {
    await enrolledAda();
    answer = { items: [send("s1", "ada@example.com")], cursor: "2026-10-22T10:00:00.000Z", complete: true };
    const [r] = await pull({ dryRun: true });
    assert.equal(r!.read, 1);
    assert.equal((await touches()).length, 0);
    assert.equal((await rows("select count(*)::int as n from acquisition.inbound_cursor"))[0].n, 0);
  });

  it("does not pull a sequencer that declares the verb not served, and fails one that declares it without the method", async () => {
    const { pullTouches: _, ...methodless } = sequencer;
    const reports = await pull({ sequencers: [silent, { ...methodless, provider: "methodless" }] });
    assert.deepEqual(reports.map((r) => r.provider), ["methodless"]);
    assert.match(reports[0]!.stoppedBy ?? "", /cannot read, so nothing was pulled: .*pullTouches/);
  });
});
