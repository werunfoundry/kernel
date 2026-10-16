/**
 * Tests for the draft and its lane's gate (decision 0027), against a real
 * database: the gate is in the runtime and again in the schema, and the
 * schema's half is only known to hold by writing past the runtime.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import type { Database } from "@werunfoundry/core/runtime/run";

import type { Attribution } from "./draft.js";
import { approve, drop, propose, queue } from "./draft.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_draft_${process.pid}`;
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

let experimentId = "";
let personId = "";
let otherPeople: string[] = [];

const agent: Attribution = { actor: { type: "agent", id: "writer" } };
const human: Attribution = { actor: { type: "human", id: "ops" } };
const GATE = { autonomyAfter: 2 };

async function setLane(lane: string, streak = 0, status = "running") {
  await client.query("update core.experiment set lane = $1, autonomy_streak = $2, status = $3 where id = $4", [lane, streak, status, experimentId]);
}
const streak = async () => (await client.query("select autonomy_streak from core.experiment where id = $1", [experimentId])).rows[0].autonomy_streak as number;
const input = (step = 1, who = personId, body = "Hello.") => ({ experimentId, personId: who, step, renderedSubject: "Hi", renderedBody: body });

beforeEach(async () => {
  if (!client) return;
  await client.query("truncate gtm.draft, core.experiment, relations.person cascade");
  experimentId = (
    await client.query("insert into core.experiment (slug, type, hypothesis_ref, status) values ('exp', 'campaign', 'https://example.com/h', 'running') returning id")
  ).rows[0].id;
  const people = (await client.query("insert into relations.person (email) select 'p' || g || '@example.com' from generate_series(1, 6) g returning id")).rows;
  personId = people[0].id;
  otherPeople = people.slice(1).map((r: { id: string }) => r.id);
});

/** A clean human approval of a fresh draft for another person, to move the streak. */
async function cleanApproval(i: number) {
  const p = await propose(db, input(1, otherPeople[i]), agent, GATE);
  assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  const a = await approve(db, p.draft.id, { by: "ops" }, human);
  assert.ok(a.ok, JSON.stringify(a));
}

describe("the lane's gate", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("reviewed: every draft waits for a human, whatever the streak", async () => {
    await setLane("reviewed", 50);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok && p.outcome === "awaiting_review" && p.draft.state === "awaiting_review", JSON.stringify(p));
  });

  it("only an approved draft is queued", async () => {
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    const q = await queue(db, p.draft.id, agent);
    assert.ok(!q.ok && /awaiting_review draft is not sent/.test(q.refused), JSON.stringify(q));
    const a = await approve(db, p.draft.id, { by: "ops" }, human);
    assert.ok(a.ok && a.draft.state === "approved" && a.draft.decidedBy === "ops" && a.autonomyStreak === 1, JSON.stringify(a));
    const q2 = await queue(db, p.draft.id, agent);
    assert.ok(q2.ok && q2.draft.state === "queued", JSON.stringify(q2));
  });

  it("an edit is recorded, sent as edited, and sets the streak back to zero", async () => {
    await setLane("autonomous", 1);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    const a = await approve(db, p.draft.id, { by: "ops", renderedBody: "Hello, corrected." }, human);
    assert.ok(a.ok && a.draft.editedBeforeApproval && a.draft.renderedBody === "Hello, corrected." && a.autonomyStreak === 0, JSON.stringify(a));
  });

  it("autonomous: waits for a human until the streak is earned, then approves on its own", async () => {
    await setLane("autonomous");
    await cleanApproval(0);
    const before = await propose(db, input(1, otherPeople[1]), agent, GATE);
    assert.ok(before.ok && before.outcome === "awaiting_review", "approved by the lane before it had earned it");
    await approve(db, before.draft.id, { by: "ops" }, human);
    assert.equal(await streak(), 2);
    const earned = await propose(db, input(), agent, GATE);
    assert.ok(earned.ok && earned.outcome === "approved_by_lane" && earned.draft.decidedBy === "lane:autonomous", JSON.stringify(earned));
    assert.equal(await streak(), 2, "an approval by the lane climbed the streak");
  });

  it("autonomous: one edit and the lane must earn it again", async () => {
    await setLane("autonomous", 5);
    const p = await propose(db, input(1, otherPeople[0]), agent, GATE);
    assert.ok(p.ok && p.outcome === "approved_by_lane");
    await setLane("autonomous", 5);
    // A human review that needed an edit, on another draft.
    await setLane("reviewed", 5);
    const reviewed = await propose(db, input(1, otherPeople[1]), agent, GATE);
    assert.ok(reviewed.ok);
    await approve(db, reviewed.draft.id, { by: "ops", renderedBody: "Better." }, human);
    await client.query("update core.experiment set lane = 'autonomous' where id = $1", [experimentId]);
    const after = await propose(db, input(), agent, GATE);
    assert.ok(after.ok && after.outcome === "awaiting_review", JSON.stringify(after));
  });

  it("reactive: with no inbound touch from the person, it requires a human", async () => {
    await setLane("reactive", 50);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("only a human approves: an agent's approval is refused", async () => {
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    const a = await approve(db, p.draft.id, { by: "writer" }, agent);
    assert.ok(!a.ok && /only a human approves/.test(a.refused), JSON.stringify(a));
    assert.equal(await streak(), 0);
  });

  it("refuses a gate with no threshold rather than choosing one", async () => {
    await assert.rejects(propose(db, input(), agent, { autonomyAfter: 0 }), /at least 1/);
  });
});

describe("drops", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("a human's drop needs a reason and sets the streak back to zero", async () => {
    await setLane("reviewed", 3);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    const blank = await drop(db, p.draft.id, { by: "ops", reason: " " }, human);
    assert.ok(!blank.ok && /says why/.test(blank.refused));
    const d = await drop(db, p.draft.id, { by: "ops", reason: "wrong person" }, human);
    assert.ok(d.ok && d.draft.state === "dropped" && d.draft.dropReason === "wrong person" && d.autonomyStreak === 0, JSON.stringify(d));
  });

  it("a drop by the system says nothing about the work and leaves the streak", async () => {
    await setLane("reviewed", 3);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    await drop(db, p.draft.id, { by: "system", reason: "superseded" }, { actor: { type: "system" } });
    assert.equal(await streak(), 3);
  });
});

describe("whatever the lane", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("drafts nothing for a person who opted out", async () => {
    await client.query("update relations.person set opted_out_at = now() where id = $1", [personId]);
    await setLane("autonomous", 50);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(!p.ok && /opted out/.test(p.refused), JSON.stringify(p));
    assert.equal((await client.query("select count(*)::int as n from gtm.draft")).rows[0].n, 0);
  });

  it("drops at the gate a person who opted out after the approval", async () => {
    await setLane("autonomous", 50);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok && p.draft.state === "approved");
    await client.query("update relations.person set opted_out_at = now() where id = $1", [personId]);
    const q = await queue(db, p.draft.id, agent);
    assert.ok(!q.ok && /opted out/.test(q.refused), JSON.stringify(q));
    const [row] = (await client.query("select state, decided_by, drop_reason from gtm.draft")).rows;
    assert.deepEqual(row, { state: "dropped", decided_by: "system", drop_reason: "the person opted out after the approval" });
  });

  it("sends nothing for an experiment that is not running", async () => {
    await setLane("autonomous", 50);
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    await setLane("autonomous", 50, "measuring");
    const q = await queue(db, p.draft.id, agent);
    assert.ok(!q.ok && /measuring, not running/.test(q.refused), JSON.stringify(q));
    assert.equal((await client.query("select state from gtm.draft")).rows[0].state, "approved");
  });
});

describe("regenerating", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("gives an undecided draft the new text, and never reopens a decided one", async () => {
    const first = await propose(db, input(1, personId, "First."), agent, GATE);
    const again = await propose(db, input(1, personId, "Second."), agent, GATE);
    assert.ok(first.ok && again.ok && again.draft.id === first.draft.id && again.draft.renderedBody === "Second.", JSON.stringify(again));
    await approve(db, first.draft.id, { by: "ops" }, human);
    const late = await propose(db, input(1, personId, "Third."), agent, GATE);
    assert.ok(late.ok && late.outcome === "kept" && late.draft.renderedBody === "Second." && late.draft.state === "approved", JSON.stringify(late));
  });
});

describe("the gate in the schema", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const awaiting = async () => {
    const p = await propose(db, input(), agent, GATE);
    assert.ok(p.ok);
    return p.draft.id;
  };

  it("refuses to queue a draft nobody approved, written past the runtime", async () => {
    const id = await awaiting();
    await assert.rejects(client.query("update gtm.draft set state = 'queued', decided_by = 'x', decided_at = now() where id = $1", [id]), /awaiting_review to queued is not a move/);
  });

  it("refuses a draft created already queued", async () => {
    await assert.rejects(
      client.query("insert into gtm.draft (experiment_id, person_id, step, state, decided_by, decided_at) values ($1, $2, 9, 'queued', 'x', now())", [experimentId, personId]),
      /cannot be created queued/,
    );
  });

  it("refuses to change the text of an approved draft", async () => {
    const id = await awaiting();
    await approve(db, id, { by: "ops" }, human);
    await assert.rejects(client.query("update gtm.draft set rendered_body = 'Something else.' where id = $1", [id]), /does not change/);
  });

  it("refuses an approval that does not say who decided", async () => {
    const id = await awaiting();
    await assert.rejects(client.query("update gtm.draft set state = 'approved' where id = $1", [id]), /draft_decided/);
  });

  it("refuses a drop without a reason", async () => {
    const id = await awaiting();
    await assert.rejects(client.query("update gtm.draft set state = 'dropped', decided_by = 'x', decided_at = now() where id = $1", [id]), /draft_dropped_has_reason/);
  });
});

describe("the reactive lane, licensed by the person's inbound touch (decision 0042)", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const WINDOW = { autonomyAfter: 2, reactiveWithinMinutes: 60 };
  let templateId = "";
  let n = 0;
  const touch = (who: string, opts: { channel?: string; direction?: string; minutesAgo?: number } = {}) =>
    client.query(
      "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, $2, $3, false, 'memory', $4, now() - ($5 || ' minutes')::interval, 'system')",
      [who, opts.channel ?? "email", opts.direction ?? "inbound", `t${++n}`, String(opts.minutesAgo ?? 5)],
    );
  const reply = (over: Partial<ReturnType<typeof input> & { templateId: string }> = {}) => ({ ...input(), templateId, ...over });

  beforeEach(async () => {
    if (!client) return;
    await setLane("reactive");
    templateId = (await client.query("insert into gtm.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello') returning id", [experimentId])).rows[0].id;
  });

  it("approves a reply on its own when the person reached us on the template's channel inside the window", async () => {
    await touch(personId);
    const p = await propose(db, reply(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "approved_by_lane" && p.draft.decidedBy === "lane:reactive", JSON.stringify(p));
    assert.equal(await streak(), 0);
  });

  it("requires a human without a window, whatever the touch", async () => {
    await touch(personId);
    const p = await propose(db, reply(), agent, GATE);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("requires a human when the touch is older than the window", async () => {
    await touch(personId, { minutesAgo: 120 });
    const p = await propose(db, reply(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("requires a human when the touch was on another channel", async () => {
    await touch(personId, { channel: "social_message" });
    const p = await propose(db, reply(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("requires a human when the touch was ours, not the person's", async () => {
    await client.query(
      "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'outbound', true, 'memory', 'ours', now(), 'system')",
      [personId],
    );
    const p = await propose(db, reply(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("requires a human when the touch is someone else's", async () => {
    await touch(otherPeople[0]!);
    const p = await propose(db, reply(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("requires a human for a draft with no template: it has no channel to check", async () => {
    await touch(personId);
    const p = await propose(db, input(), agent, WINDOW);
    assert.ok(p.ok && p.outcome === "awaiting_review", JSON.stringify(p));
  });

  it("refuses a window that is not one rather than choosing one", async () => {
    await assert.rejects(propose(db, reply(), agent, { autonomyAfter: 2, reactiveWithinMinutes: 0 }), /above zero/);
  });
});
