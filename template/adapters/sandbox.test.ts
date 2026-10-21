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

import { identityVocabulary } from "@werunfoundry/core/identity";
import { acceptCompletion } from "@werunfoundry/relations/contracts/enrichment";

import enrichmentFactory from "./sandbox-enrichment.ts";
import inboundFactory from "./sandbox-inbound.ts";
import metricsFactory from "./sandbox-metrics.ts";
import sequencerFactory, { sequencerOn } from "./sandbox-sequencer.ts";
import { loadState, saveState } from "./sandbox-store.ts";
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

  it("metrics: a guardrail asked about a channel it does not exist on is not applicable, never zero", async () => {
    const source = metricsFactory({ options: { stateFile: join(dir, "m.json") }, env: {} });
    const social = await source.read({ key: "acquisition.bounced", channel: "social_message" }, ctx(true));
    assert.ok(social.ok && !social.value.applicable, JSON.stringify(social));
    const email = await source.read({ key: "acquisition.bounced", channel: "email" }, ctx(true));
    assert.ok(email.ok && email.value.applicable && email.value.value === 0);
  });

  it("metrics: a key the source does not read is refused, never zero", async () => {
    const r = await metricsFactory({ options: { stateFile: join(dir, "m.json") }, env: {} }).read({ key: "acquisition.opened" }, ctx(true));
    assert.equal(r.ok, false);
  });
});

describe("enrichment: a completion the contract accepts (0022)", () => {
  const vocabulary = identityVocabulary(
    [
      {
        name: "relations",
        version: "0.0.0",
        description: "x",
        schema: "relations",
        dependsOn: [],
        identityKeys: [
          { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
          { kind: "social_profile_id", subject: "person", immutable: true, networked: true },
        ],
      },
    ],
    ["sandbox"],
  );
  const enrichment = enrichmentFactory({ options: { network: "sandbox" }, env: {} });

  it("is accepted for a person found by peopleAt, who carries an immutable key", async () => {
    const page = await enrichment.peopleAt({ company: company("open.example.com") }, ctx(true));
    assert.ok(page.ok && page.value.items.length > 0, JSON.stringify(page));
    if (!page.ok) return;
    const byId = { subject: "person", keys: page.value.items[0]!.identity.keys.filter((k) => k.kind === "social_profile_id") };
    const r = await enrichment.complete({ identity: byId }, ctx(true));
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (!r.ok) return;
    const accepted = acceptCompletion(byId, r.value, vocabulary);
    assert.ok("accepted" in accepted, JSON.stringify(accepted));
    if ("accepted" in accepted) assert.deepEqual(accepted.added, [{ kind: "email", value: "ada@open.example.com" }]);
  });

  it("is rejected for a person known only by an address: nothing immutable ties the answer to them", async () => {
    const byAddress = { subject: "person", keys: [{ kind: "email", value: "ada@open.example.com" }] };
    const r = await enrichment.complete({ identity: byAddress }, ctx(true));
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (r.ok) {
      assert.deepEqual(acceptCompletion(byAddress, r.value, vocabulary), {
        rejected: "the answer attests no immutable key of the subject asked about: nothing ties it to them",
      });
    }
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

  it("says which enrolment it read, by the key its record holds, in status and in a withdrawal (0060)", async () => {
    const status = await sequencer.status({ person: ada, sequenceKey: "welcome" }, ctx(false));
    assert.ok(status.ok && status.value.idempotencyKey === "k1", JSON.stringify(status));
    const dry = await sequencer.withdraw({ idempotencyKey: "k1", person: ada, sequenceKey: "welcome", reason: "x" }, ctx(true));
    assert.ok(dry.ok && dry.value.found && dry.value.idempotencyKey === "k1", JSON.stringify(dry));
    const done = await sequencer.withdraw({ idempotencyKey: "k1", person: ada, sequenceKey: "welcome", reason: "x" }, ctx(false));
    assert.ok(done.ok && done.value.found && done.value.readBack && done.value.idempotencyKey === "k1", JSON.stringify(done));
    const gone = await sequencer.status({ person: ada, sequenceKey: "welcome" }, ctx(false));
    assert.ok(gone.ok && gone.value.state === "unknown" && gone.value.idempotencyKey === undefined, JSON.stringify(gone));
  });

  it("reads a suppression back from the state file, and is refused by it afterwards (0051)", async () => {
    const bob = { subject: "person", keys: [{ kind: "email", value: "Bob@Open.example.com" }] };
    const before = new Date().toISOString();
    const r = await sequencer.suppress({ idempotencyKey: "s1", reason: "x", target: bob }, ctx(false));
    assert.ok(r.ok && !r.simulated && r.value.applied.length === 1 && r.value.asOf >= before, JSON.stringify(r));
    const listed = loadState(state);
    assert.ok(listed.ok && listed.value.suppressed.includes("bob@open.example.com"), JSON.stringify(listed));
    const refused = await sequencer.enrol({ ...enrolment, idempotencyKey: "k3", person: bob }, ctx(false));
    assert.ok(!refused.ok && refused.error.code === "invalid", JSON.stringify(refused));
  });

  it("does not report a suppression applied when the state file, read back, does not list it (0051)", async () => {
    // A store whose writes do not hold: the save answers, and lists nothing.
    const lost = join(dir, "lost.json");
    const forgetful = sequencerOn({ load: loadState, save: (path, s) => saveState(path, { ...s, suppressed: [] }) })({ options: { stateFile: lost }, env: {} });
    const r = await forgetful.suppress({ idempotencyKey: "s2", reason: "x", target: { subject: "person", keys: [{ kind: "email", value: "cy@open.example.com" }] } }, ctx(false));
    assert.ok(!r.ok && r.error.code === "unknown" && !r.error.retryable, JSON.stringify(r));
    if (!r.ok) assert.equal(r.error.message, "the state file, read back, lists 0 of the 1 keys written");
  });

  it("refuses to suppress an identity it cannot act on", async () => {
    const r = await sequencer.suppress(
      { idempotencyKey: "s", reason: "x", target: { subject: "person", keys: [{ kind: "social_profile_id", network: "n", value: "p" }] } },
      ctx(false),
    );
    assert.equal(r.ok, false);
  });
});
