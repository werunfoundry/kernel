/**
 * The rule that turns a sender's limits into what it can still do (decision
 * 0020), and what an adapter declares it can do (decision 0051).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Capacity, CapacityLimit, SequencerDeclaration } from "./sequencer.js";
import { checkDeclaration, readDeclaration, remainingOf } from "./sequencer.js";

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

/* -------------------------------------------------------------------------- */

const declaration = (over: Partial<SequencerDeclaration> = {}): SequencerDeclaration => ({
  enrol: { serves: "yes" },
  pullTouches: { serves: "partially", why: "by time only, not by person" },
  suspend: {
    serves: "yes",
    method: "parking the person in a far-off step",
    costs: { person: ["provider_status_stays_active"], sequence: ["shared_state_changes"] },
    gap: { known: true, minutes: 7, basis: "a live test at known offsets", measuredOn: "2026-10-20" },
  },
  pullUnsubscribes: { serves: "no", why: "the provider exposes no unsubscribe event" },
  ...over,
});
const at = (d: unknown) => checkDeclaration(d).map((i) => i.at);

describe("checkDeclaration", () => {
  it("accepts a declaration that says, for each verb, whether it is served", () => {
    assert.deepEqual(checkDeclaration(declaration()), []);
  });

  it("requires all four verbs, a reason for anything not fully served", () => {
    const { pullUnsubscribes: _, ...missing } = declaration();
    assert.deepEqual(at(missing), ["pullUnsubscribes"]);
    assert.deepEqual(at(declaration({ pullTouches: { serves: "partially", why: " " } })), ["pullTouches.why"]);
  });

  it("requires both sides of the cost, in the decision's vocabulary only", () => {
    const s = declaration().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    assert.deepEqual(at(declaration({ suspend: { ...s, costs: { person: [] } as never } })), ["suspend.costs"]);
    assert.deepEqual(at(declaration({ suspend: { ...s, costs: { person: ["mildly_annoying" as never], sequence: [] } } })), ["suspend.costs.person"]);
  });

  it("requires a measured gap to carry its basis and its date, and an unknown one to say why", () => {
    const s = declaration().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    assert.deepEqual(at(declaration({ suspend: { ...s, gap: { known: true, minutes: 7, basis: "", measuredOn: "last week" } } })), ["suspend.gap.basis", "suspend.gap.measuredOn"]);
    assert.deepEqual(at(declaration({ suspend: { ...s, gap: { known: false, why: "" } } })), ["suspend.gap.why"]);
    assert.deepEqual(at(declaration({ suspend: { ...s, gap: { known: false, why: "never measured" } } })), []);
  });

  it("requires a way passed over to be named, with why", () => {
    const s = declaration().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    assert.deepEqual(at(declaration({ suspend: { ...s, notTheLeastDestructive: { available: "parking", why: "" } } })), ["suspend.notTheLeastDestructive"]);
  });
});

describe("readDeclaration", () => {
  it("lets the kernel enrol only through an adapter that declares, validly, that it can suspend", () => {
    assert.equal(readDeclaration({ provider: "p", declares: declaration() }).suspends, true);
    assert.equal(readDeclaration({ provider: "p" }).suspends, false);
    assert.equal(readDeclaration({ provider: "p", declares: declaration({ suspend: { serves: "no", why: "no way to stop one person" } }) }).suspends, false);
    assert.equal(readDeclaration({ provider: "p", declares: { ...declaration(), enrol: undefined } as never }).suspends, false);
  });

  it("prints every incapacity and both sides of the cost, and the gap with its basis and date", () => {
    const { lines } = readDeclaration({ provider: "p", declares: declaration() });
    const text = lines.join("\n");
    assert.match(text, /pull the touches: serves partially — by time only, not by person/);
    assert.match(text, /pull the unsubscribes: does not serve — the provider exposes no unsubscribe event/);
    assert.match(text, /costs the person: the provider's status keeps reading active/);
    assert.match(text, /costs the shared sequence: the sequence's own state changes, for everyone else in it/);
    assert.match(text, /gap: 7 minutes after the read-back \(a live test at known offsets, measured 2026-10-20\)/);
  });

  it("says an unknown gap is unknown, and what that means for a touch after a suspension", () => {
    const s = declaration().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    const { lines } = readDeclaration({ provider: "p", declares: declaration({ suspend: { ...s, gap: { known: false, why: "never measured" } } }) });
    assert.match(lines.join("\n"), /gap: unknown — never measured; every touch after a suspension is reported, neither a breach nor accepted/);
  });
});
