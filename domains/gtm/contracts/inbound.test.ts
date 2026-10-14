/**
 * Tests for the check an inbound event passes before it is stored. The
 * pull-and-cursor behaviour is a property of adapters, tested on the
 * template's example.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { identityVocabulary } from "@werunfoundry/core/identity";

import type { InboundEvent } from "./inbound.js";
import { checkInboundEvent } from "./inbound.js";

const known = {
  eventTypes: new Set(["gtm.reply", "gtm.bounce"]),
  identity: identityVocabulary([
    {
      name: "relations",
      version: "0.0.0",
      description: "x",
      schema: "relations",
      dependsOn: [],
      identityKeys: [{ kind: "email", subject: "person", immutable: false, caseInsensitive: true }],
    },
  ]),
};

const reply = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  providerEventId: "evt-1",
  type: "gtm.reply",
  occurredAt: "2026-01-02T03:04:05Z",
  subject: { subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] },
  attribution: { runId: "6f1c9a2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b", sequenceKey: "welcome", channel: "email" },
  ...over,
});

const said = (e: InboundEvent) => checkInboundEvent(e, known).map((i) => `${i.at} ${i.message}`).join("\n");

describe("an inbound event before it is stored", () => {
  it("accepts one tied to an identity and a run", () => {
    assert.equal(said(reply()), "");
  });

  it("accepts one the engine did not cause, with no run", () => {
    const { attribution: _, ...unattributed } = reply();
    assert.equal(said(unattributed), "");
  });

  it("refuses everything wrong at once", () => {
    const out = said(
      reply({
        providerEventId: " ",
        type: "gtm.opened",
        occurredAt: "yesterday",
        subject: { subject: "person", keys: [] },
        attribution: { runId: "run-42" },
      }),
    );
    assert.match(out, /providerEventId empty/);
    assert.match(out, /no enabled domain declares the event type "gtm.opened"/);
    assert.match(out, /occurredAt not a time/);
    assert.match(out, /subject\.keys an identity with no key names nothing/);
    assert.match(out, /attribution\.runId not a run id/);
  });
});
