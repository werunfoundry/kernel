/** The rule that turns a sender's limits into what it can still do (decision 0020). */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Capacity, CapacityLimit } from "./sequencer.js";
import { remainingOf } from "./sequencer.js";

const capacity = (...limits: CapacityLimit[]): Capacity => ({
  sender: { externalId: "sender@example.com" },
  channel: "social_invite",
  limits,
  asOf: "2026-01-01T00:00:00Z",
});

describe("remainingOf", () => {
  it("is the tightest limit, and names it", () => {
    const r = remainingOf(capacity({ unit: "invitations", window: "day", remaining: 20 }, { unit: "invitations", window: "week", remaining: 3 }));
    assert.ok("remaining" in r);
    if ("remaining" in r) assert.deepEqual([r.remaining, r.binding.window], [3, "week"]);
  });

  it("is unknown when any limit does not say what is left — never the loosest of the rest", () => {
    assert.deepEqual(
      remainingOf(capacity({ unit: "invitations", window: "day", remaining: 20 }, { unit: "invitations", window: "week" })),
      { unknown: "the provider did not say what is left of its week limit" },
    );
  });

  it("is unknown when limits count different things", () => {
    const r = remainingOf(capacity({ unit: "messages", window: "day", remaining: 5 }, { unit: "invitations", window: "week", remaining: 1 }));
    assert.ok("unknown" in r);
  });

  it("is unknown when there is no limit at all", () => {
    assert.deepEqual(remainingOf(capacity()), { unknown: "the provider reported no limit" });
  });

  it("keeps a single limit as it is", () => {
    const r = remainingOf(capacity({ unit: "messages", window: "day", remaining: 7 }));
    assert.ok("remaining" in r && r.remaining === 7);
  });
});
