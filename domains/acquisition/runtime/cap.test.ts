/** The cap judged ahead (decision 0064 §3). Pure: no database. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { judgeAhead, planTimes } from "./cap.js";

const day = (n: number) => new Date(Date.UTC(2026, 10, 1) + n * 24 * 60 * 60 * 1000);
const cap = { max: 3, withinDays: 30 };

describe("the cap, judged ahead over the whole plan (0064 §3)", () => {
  it("lets through a plan whose every window stays within the cap, past touches included", () => {
    assert.deepEqual(judgeAhead([day(-20)], [day(0), day(40), day(80)], cap), { within: true, busiest: 2 });
  });

  it("refuses a plan that puts more than the cap in some window, and says which", () => {
    const r = judgeAhead([day(-10), day(-5)], [day(0), day(10), day(50)], cap);
    assert.deepEqual(r, { within: false, count: 4, from: day(-10), to: day(10) });
  });

  it("refuses a window anywhere ahead, not only the one behind", () => {
    // Nothing behind; the plan's own steps 3 and 4 fall close together.
    const r = judgeAhead([], [day(0), day(40), day(60), day(65), day(69)], cap);
    assert.equal(r.within, false);
    if (!r.within) assert.deepEqual([r.count, r.from, r.to], [4, day(40), day(69)]);
  });

  it("counts the steps still planned of other enrolments, as they will leave", () => {
    const others = [day(5), day(12)];
    assert.equal(judgeAhead(others, [day(0), day(20)], cap).within, false);
    assert.equal(judgeAhead(others, [day(0), day(60)], cap).within, true);
  });

  it("does not refuse a plan for a window it adds nothing to", () => {
    // Four touches already in the past month, none of this plan's steps among them.
    assert.equal(judgeAhead([day(-40), day(-38), day(-36), day(-34)], [day(0)], cap).within, true);
  });

  it("holds a window open at its end: a touch exactly the cap's length later is the next window's", () => {
    assert.equal(judgeAhead([], [day(0), day(10), day(20), day(30)], cap).within, true);
    assert.equal(judgeAhead([], [day(0), day(10), day(20), new Date(day(30).getTime() - 1)], cap).within, false);
  });

  it("refuses everything under a cap of zero, and a cap that is not a count", () => {
    assert.equal(judgeAhead([], [day(0)], { max: 0, withinDays: 30 }).within, false);
    assert.throws(() => judgeAhead([], [day(0)], { max: 1.5, withinDays: 30 }), /whole number/);
    assert.throws(() => judgeAhead([], [day(0)], { max: 1, withinDays: 0 }), /more than 0 days/);
  });

  it("times a plan's steps from its start, each after the one before", () => {
    assert.deepEqual(planTimes(day(0), [{ afterPreviousMinutes: 0 }, { afterPreviousMinutes: 3 * 24 * 60 }, { afterPreviousMinutes: 24 * 60 }]), [day(0), day(3), day(4)]);
  });
});
