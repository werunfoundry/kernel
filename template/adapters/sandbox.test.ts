/**
 * The sandbox adapters keep the promises their contracts make, so that an
 * instance learns the shape of a good adapter from the ones it starts with:
 * "found nothing" is a success and "could not look" is an error (0016,
 * 0017), and a dry run writes nothing.
 *
 *   node --test adapters/
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import enrichmentFactory from "./sandbox-enrichment.ts";
import inboundFactory from "./sandbox-inbound.ts";
import metricsFactory from "./sandbox-metrics.ts";
import sequencerFactory from "./sandbox-sequencer.ts";
import targetListFactory from "./sandbox-target-list.ts";

const dir = mkdtempSync(join(tmpdir(), "sandbox-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (dryRun: boolean) => ({ runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" as const }, dryRun });
const missing = { dataFile: join(dir, "no-such-data.json") };
const company = (domain: string) => ({ subject: "company", keys: [{ kind: "domain", value: domain }] });

describe("found nothing is not could not look", () => {
  it("enrichment: an unknown company is an empty page", async () => {
    const r = await enrichmentFactory({ options: {}, env: {} }).peopleAt({ company: company("nobody.example.org") }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value.items, []);
  });

  it("enrichment: unreadable data is an error, not an empty page", async () => {
    const r = await enrichmentFactory({ options: missing, env: {} }).peopleAt({ company: company("open.example.com") }, ctx(true));
    assert.equal(r.ok, false);
  });

  it("inbound: unreadable data is an error, not an empty page", async () => {
    const r = await inboundFactory({ options: missing, env: {} }).events({}, ctx(true));
    assert.equal(r.ok, false);
  });

  it("inbound: the cursor comes back even when nothing is new", async () => {
    const r = await inboundFactory({ options: {}, env: {} }).events({ after: "99" }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.value.items.length, r.value.cursor], [0, "99"]);
  });

  it("target list: an unreadable protected set is an error, never an empty one", async () => {
    const r = await targetListFactory({ options: missing, env: {} }).protectedAccounts({}, ctx(true));
    assert.equal(r.ok, false);
  });

  it("metrics: a key the source does not read is refused, never zero", async () => {
    const r = await metricsFactory({ options: { stateFile: join(dir, "m.json") }, env: {} }).read({ key: "gtm.bounced" }, ctx(true));
    assert.equal(r.ok, false);
  });
});

describe("the sequencer", () => {
  const state = join(dir, "seq.json");
  const sequencer = sequencerFactory({ options: { stateFile: state }, env: {} });
  const ada = { subject: "person", keys: [{ kind: "email", value: "ada@open.example.com" }] };
  const enrolment = { idempotencyKey: "k1", sequenceKey: "welcome", channel: "email", person: ada };

  it("writes nothing in a dry run", async () => {
    const r = await sequencer.enrol(enrolment, ctx(true));
    assert.equal(r.ok, true);
    assert.equal(existsSync(state), false);
  });

  it("enrols once, recognises the replay, and calls another key a conflict", async () => {
    assert.equal((await sequencer.enrol(enrolment, ctx(false))).ok, true);
    assert.equal((await sequencer.enrol(enrolment, ctx(false))).ok, true);
    const other = await sequencer.enrol({ ...enrolment, idempotencyKey: "k2" }, ctx(false));
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error.code, "conflict");
  });

  it("refuses to suppress an identity it cannot act on", async () => {
    const r = await sequencer.suppress(
      { idempotencyKey: "s", reason: "x", target: { subject: "person", keys: [{ kind: "social_profile_id", network: "n", value: "p" }] } },
      ctx(false),
    );
    assert.equal(r.ok, false);
  });
});
