/** Tests for which experiment types the bound sources can judge. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { DomainManifest } from "./types.js";
import { measurability } from "./measure.js";

const domain: DomainManifest = {
  name: "acq",
  version: "0.0.0",
  description: "x",
  schema: "acq",
  dependsOn: [],
  experimentTypes: ["message_test", "offer_test", "unjudged"],
  metrics: [{ key: "acq.enrolled", unit: "people" }, { key: "acq.replied", unit: "people" }, { key: "acq.won", unit: "deals" }],
  experimentMetrics: { message_test: ["acq.enrolled", "acq.replied"], offer_test: ["acq.enrolled", "acq.won"] },
};

describe("measurability", () => {
  it("is measurable when a bound source reads every metric the type is judged on", () => {
    const [message, offer] = measurability([domain], [{ metrics: ["acq.enrolled", "acq.replied"] }]);
    assert.deepEqual(message, { experimentType: "message_test", metrics: ["acq.enrolled", "acq.replied"], missing: [], measurable: true });
    assert.deepEqual([offer?.measurable, offer?.missing], [false, ["acq.won"]]);
  });

  it("reads across sources: two sources together can judge what neither can alone", () => {
    const all = measurability([domain], [{ metrics: ["acq.enrolled"] }, { metrics: ["acq.won"] }]);
    assert.equal(all.find((m) => m.experimentType === "offer_test")?.measurable, true);
  });

  it("never calls a type judged on nothing measurable", () => {
    const unjudged = measurability([domain], [{ metrics: ["acq.enrolled", "acq.replied", "acq.won"] }]).find((m) => m.experimentType === "unjudged");
    assert.deepEqual([unjudged?.metrics, unjudged?.missing, unjudged?.measurable], [[], [], false]);
  });

  it("with no source, measures nothing", () => {
    assert.ok(measurability([domain], []).every((m) => !m.measurable));
  });
});
