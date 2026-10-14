/**
 * Tests for which experiment types the bound sources can judge, channel by
 * channel, and for reading a metric that does not apply — 0009's rule for
 * probes, applied to numbers: absent is reported as absent, never as health.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { MetricSource } from "../contracts/types.js";
import type { DomainManifest } from "./types.js";
import { measurability, readMetric } from "./measure.js";

const domain: DomainManifest = {
  name: "acq",
  version: "0.0.0",
  description: "x",
  schema: "acq",
  dependsOn: [],
  channels: ["email", "social"],
  experimentTypes: ["message_test", "offer_test", "guarded_only", "unjudged"],
  metrics: [
    { key: "acq.enrolled", unit: "people" },
    { key: "acq.replied", unit: "people" },
    { key: "acq.won", unit: "deals" },
    { key: "acq.bounced", unit: "people", channels: ["email"] },
  ],
  experimentMetrics: {
    message_test: ["acq.enrolled", "acq.replied", "acq.bounced"],
    offer_test: ["acq.enrolled", "acq.won"],
    guarded_only: ["acq.bounced"],
  },
};
const everything = [{ metrics: ["acq.enrolled", "acq.replied", "acq.won", "acq.bounced"] }];
const typeOf = (all: ReturnType<typeof measurability>, name: string) => all.find((m) => m.experimentType === name)!;

describe("measurability, channel by channel", () => {
  it("does not count a metric that does not apply on a channel, as missing or as present", () => {
    const message = typeOf(measurability([domain], everything), "message_test");
    const social = message.channels.find((c) => c.channel === "social")!;
    assert.deepEqual([social.applicable, social.notApplicable, social.missing, social.measurable], [
      ["acq.enrolled", "acq.replied"],
      ["acq.bounced"],
      [],
      true,
    ]);
    assert.equal(message.measurable, true);
  });

  it("never calls a type measurable on a channel where none of its metrics applies", () => {
    const guarded = typeOf(measurability([domain], everything), "guarded_only");
    const social = guarded.channels.find((c) => c.channel === "social")!;
    assert.deepEqual([social.applicable, social.measurable], [[], false]);
    assert.equal(guarded.channels.find((c) => c.channel === "email")?.measurable, true);
  });

  it("is unmeasurable when a metric is missing where it applies", () => {
    const message = typeOf(measurability([domain], [{ metrics: ["acq.enrolled", "acq.replied"] }]), "message_test");
    assert.deepEqual([message.missing, message.measurable], [["acq.bounced"], false]);
    assert.equal(message.channels.find((c) => c.channel === "social")?.measurable, true, "on social, the missing guardrail does not apply");
  });

  it("reads across sources", () => {
    assert.equal(typeOf(measurability([domain], [{ metrics: ["acq.enrolled"] }, { metrics: ["acq.won"] }]), "offer_test").measurable, true);
  });

  it("never calls a type judged on nothing measurable, and with no source measures nothing", () => {
    assert.equal(typeOf(measurability([domain], everything), "unjudged").measurable, false);
    assert.ok(measurability([domain], []).every((m) => !m.measurable));
  });
});

describe("reading a metric", () => {
  const ctx = { runId: "r", actor: { type: "system" as const }, dryRun: true };
  let asked = 0;
  /** A source that would answer zero to anything — the failure this guards against. */
  const zeroes: MetricSource = {
    provider: "zeroes",
    metrics: ["acq.bounced", "acq.replied"],
    async read(query) {
      asked++;
      return { ok: true, value: { key: query.key, applicable: true, value: 0, asOf: "2026-01-01T00:00:00Z", source: "zeroes" } };
    },
  };

  it("reports not applicable for a channel the metric does not exist on, without asking the source", async () => {
    asked = 0;
    const r = await readMetric(zeroes, { key: "acq.bounced", channel: "social" }, domain.metrics!, ctx);
    assert.equal(asked, 0);
    assert.ok(r.ok && !r.value.applicable, JSON.stringify(r));
    assert.ok(r.ok && !("value" in r.value), "a not-applicable reading carries no number");
  });

  it("keeps a real zero a zero", async () => {
    const r = await readMetric(zeroes, { key: "acq.bounced", channel: "email" }, domain.metrics!, ctx);
    assert.ok(r.ok && r.value.applicable && r.value.value === 0);
  });

  it("asks the source for an unscoped metric on any channel", async () => {
    asked = 0;
    await readMetric(zeroes, { key: "acq.replied", channel: "social" }, domain.metrics!, ctx);
    assert.equal(asked, 1);
  });
});
