/**
 * The rule that turns a sender's limits into what it can still do (decision
 * 0020), and what an adapter declares it can do (decision 0051).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Capacity, CapacityLimit, SequencerDeclaration } from "./sequencer.js";
import { checkDeclaration, deliveryOf, readDeclaration, remainingOf } from "./sequencer.js";

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
  pullTouches: { serves: "no", why: "the provider lists sends by time only" },
  suspend: {
    serves: "yes",
    method: "parking the person in a far-off step",
    costs: { person: ["provider_status_stays_active"], sequence: ["shared_state_changes"] },
    gap: { known: true, minutes: 7, basis: "a live test at known offsets", measuredOn: "2026-10-20" },
  },
  pullUnsubscribes: { serves: "no", why: "the provider exposes no unsubscribe event" },
  ...over,
});
const at = (d: unknown, adapter?: unknown) => checkDeclaration(d, adapter).map((i) => i.at);
/** An adapter with a method behind each verb this contract has one for. */
const methods = { enrol: () => undefined, withdraw: () => undefined };
const adapter = (declares: unknown, over: Record<string, unknown> = {}) => ({ provider: "p", declares, ...methods, ...over }) as Parameters<typeof readDeclaration>[0];

describe("checkDeclaration", () => {
  it("accepts a declaration that says, for each verb, whether it is served", () => {
    assert.deepEqual(checkDeclaration(declaration()), []);
  });

  it("requires all four verbs, a reason for anything not fully served", () => {
    const { pullUnsubscribes: _, ...missing } = declaration();
    assert.deepEqual(at(missing), ["pullUnsubscribes"]);
    assert.deepEqual(at(declaration({ enrol: { serves: "partially", why: " " } })), ["enrol.why"]);
  });

  it("refuses a verb declared served that the contract has no method for (0054)", () => {
    // The touches pull: enrol and suspend are served with their methods
    // present, so the refusal can only come from the missing method in the contract.
    assert.deepEqual(at({ ...declaration(), pullTouches: { serves: "yes" } }, methods), ["pullTouches.serves"]);
    assert.deepEqual(at({ ...declaration(), pullTouches: { serves: "partially", why: "by time" } }, methods), ["pullTouches.serves"]);
  });

  it("accepts the unsubscribes pull served by an adapter that has the method, and refuses it on one that has not (0051 verb 4)", () => {
    const served = { ...declaration(), pullUnsubscribes: { serves: "partially", why: "no date of its own" } };
    assert.deepEqual(at(served, { ...methods, pullUnsubscribes: () => undefined }), []);
    assert.deepEqual(at(served, methods), ["pullUnsubscribes"]);
  });

  it("refuses, given the adapter, a verb declared served whose method is not a function on it (0054)", () => {
    // The declaration is valid on its own, pulls not served: only the adapter is wrong.
    assert.deepEqual(at(declaration(), methods), []);
    assert.deepEqual(at(declaration(), { enrol: methods.enrol }), ["suspend"]);
    assert.deepEqual(at(declaration(), { withdraw: methods.withdraw, enrol: "yes" }), ["enrol"]);
    assert.deepEqual(at(declaration({ suspend: { serves: "no", why: "no way to stop one person" } }), { enrol: methods.enrol }), []);
  });

  it("without the adapter, reads the form and nothing more: a suspension with no withdraw behind it passes", () => {
    // Documented as partial on purpose; readDeclaration, the gate, always gives the adapter.
    assert.deepEqual(at(declaration()), []);
    assert.equal(readDeclaration(adapter(declaration(), { withdraw: undefined })).suspends, false);
  });

  it("holds the pulls in the type too, for an adapter the compiler sees", () => {
    // @ts-expect-error — a pull has no method in the contract, so it is not served (0054)
    const served: SequencerDeclaration = { ...declaration(), pullTouches: { serves: "yes" } };
    // @ts-expect-error — nor served partially
    const partial: SequencerDeclaration = { ...declaration(), pullTouches: { serves: "partially", why: "by time" } };
    assert.ok(served && partial);
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
    assert.equal(readDeclaration(adapter(declaration())).suspends, true);
    assert.equal(readDeclaration({ provider: "p" }).suspends, false);
    assert.equal(readDeclaration(adapter(declaration({ suspend: { serves: "no", why: "no way to stop one person" } }))).suspends, false);
    assert.equal(readDeclaration(adapter({ ...declaration(), enrol: undefined })).suspends, false);
  });

  it("refuses what the review ran: both pulls served, on an adapter with no withdraw (0054)", () => {
    const declares = { ...declaration(), pullTouches: { serves: "yes" }, pullUnsubscribes: { serves: "yes" } };
    const read = readDeclaration(adapter(declares, { withdraw: undefined }));
    assert.equal(read.suspends, false);
    for (const reason of [/pullTouches\.serves: the contract has no method/, /pullUnsubscribes: declared served, but `pullUnsubscribes` is not a function/, /suspend: declared served, but `withdraw` is not a function/]) {
      assert.match(read.refusal ?? "", reason);
    }
  });

  it("refuses a declared suspension the adapter has no withdraw for, whatever the declaration says", () => {
    assert.equal(readDeclaration(adapter(declaration(), { withdraw: undefined })).suspends, false);
  });

  it("prints every incapacity and both sides of the cost, and the gap with its basis and date", () => {
    const { lines } = readDeclaration(adapter(declaration()));
    const text = lines.join("\n");
    assert.match(text, /pull the touches: does not serve — the provider lists sends by time only/);
    assert.match(text, /pull the unsubscribes: does not serve — the provider exposes no unsubscribe event/);
    assert.match(text, /costs the person: the provider's status keeps reading active/);
    assert.match(text, /costs the shared sequence: the sequence's own state changes, for everyone else in it/);
    assert.match(text, /gap: 7 minutes after the read-back \(a live test at known offsets, measured 2026-10-20\)/);
  });

  it("says an unknown gap is unknown, and what that means for a touch after a suspension", () => {
    const s = declaration().suspend as Extract<SequencerDeclaration["suspend"], { serves: "yes" }>;
    const { lines } = readDeclaration(adapter(declaration({ suspend: { ...s, gap: { known: false, why: "never measured" } } })));
    assert.match(lines.join("\n"), /gap: unknown — never measured; every touch after a suspension is reported, neither a breach nor accepted/);
  });
});

/* -------------------------------------------------------------------------- */
/* Decision 0065: the form delivered, the way out, a reply asking to stop      */
/* -------------------------------------------------------------------------- */

const measuredOn = { basis: "one send, read at the client", measuredOn: "2026-10-21" };

describe("0065's declarations", () => {
  it("are optional: an adapter that says nothing of them is a well-formed declaration", () => {
    assert.deepEqual(checkDeclaration(declaration()), []);
  });

  it("hold the defaults that assume the least when left out", () => {
    assert.deepEqual(deliveryOf(declaration()), {
      form: "either",
      wayOut: { offered: "none", why: "the adapter does not say (decision 0065)" },
      wayOutDeclared: false,
      classesStop: false,
    });
  });

  it("read a declared form, way out and stop-classing as declared", () => {
    const d = declaration({
      deliveredForm: { form: "plain_text", ...measuredOn },
      wayOut: { offered: "known_after", what: "the provider's unsubscribe link", window: { known: true, seconds: 60, ...measuredOn } },
      classesStop: { classes: "yes", ...measuredOn },
    });
    assert.deepEqual(checkDeclaration(d), []);
    const r = deliveryOf(d);
    assert.deepEqual([r.form, r.wayOut.offered, r.wayOutDeclared, r.classesStop], ["plain_text", "known_after", true, true]);
  });

  it("refuse a form claimed without what it was measured from, or one that is not a form", () => {
    assert.deepEqual(at(declaration({ deliveredForm: { form: "plain_text", basis: "", measuredOn: "yesterday" } })), ["deliveredForm.basis", "deliveredForm.measuredOn"]);
    assert.deepEqual(at(declaration({ deliveredForm: { form: "rtf" as never, ...measuredOn } })), ["deliveredForm.form"]);
  });

  it("refuse a way out with no name, a window neither measured nor said unknown, and none without why", () => {
    assert.deepEqual(at(declaration({ wayOut: { offered: "known_before", what: " " } })), ["wayOut.what"]);
    assert.deepEqual(at(declaration({ wayOut: { offered: "known_after", what: "a link", window: {} as never } })), ["wayOut.window"]);
    assert.deepEqual(at(declaration({ wayOut: { offered: "known_after", what: "a link", window: { known: true, seconds: -1, ...measuredOn } } })), ["wayOut.window.seconds"]);
    assert.deepEqual(at(declaration({ wayOut: { offered: "known_after", what: "a link", window: { known: false, why: "" } } })), ["wayOut.window.why"]);
    assert.deepEqual(at(declaration({ wayOut: { offered: "none", why: "" } })), ["wayOut.why"]);
    assert.deepEqual(at(declaration({ wayOut: { offered: "maybe" } as never })), ["wayOut.offered"]);
  });

  it("refuse a stop classed by the provider without proof", () => {
    assert.deepEqual(at(declaration({ classesStop: { classes: "yes", basis: "", measuredOn: "" } })), ["classesStop.basis", "classesStop.measuredOn"]);
    assert.deepEqual(at(declaration({ classesStop: { classes: "no", why: "" } })), ["classesStop.why"]);
    assert.deepEqual(at(declaration({ classesStop: { classes: "maybe" } as never })), ["classesStop.classes"]);
  });

  it("make a malformed declaration refuse the enrolment, as any unreadable declaration does (0051)", () => {
    const read = readDeclaration(adapter(declaration({ classesStop: { classes: "yes", basis: "", measuredOn: "2026-10-21" } })));
    assert.equal(read.suspends, false);
    assert.match(read.refusal ?? "", /classesStop\.basis: a claim about the provider says what it was measured from/);
  });

  it("print each default as the default, so that silence reads as what it is", () => {
    const text = readDeclaration(adapter(declaration())).lines.join("\n");
    assert.match(text, /delivers a body as: not declared — the kernel writes a body that reads the same in either form/);
    assert.match(text, /a way out in the body: not declared — none is written, and each enrolment records that its body carried none/);
    assert.match(text, /a reply asking to stop: not classed by the provider — not declared, so held not to be/);
  });

  it("print what is declared, with what it was measured from", () => {
    const d = declaration({
      deliveredForm: { form: "plain_text", ...measuredOn },
      wayOut: { offered: "known_after", what: "the provider's unsubscribe link", window: { known: false, why: "never measured" } },
      classesStop: { classes: "no", why: "not proved" },
    });
    const text = readDeclaration(adapter(d)).lines.join("\n");
    assert.match(text, /delivers a body as: plain text \(one send, read at the client, measured 2026-10-21\)/);
    assert.match(text, /a way out in the body: the provider's unsubscribe link, known only after the call/);
    assert.match(text, /window before a first step can leave: unknown — never measured/);
    assert.match(text, /a reply asking to stop: not classed by the provider — not proved; a person records it at a terminal/);
  });
});
