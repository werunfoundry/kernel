/**
 * A sequence's steps held against the templates (decision 0064, §5). Pure:
 * no database, no provider.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { SequenceStep } from "../contracts/sequencer.js";
import type { PlannedStep } from "./steps.js";
import { compareSteps } from "./steps.js";

const DAY = 24 * 60;
const step = (n: number, over: Partial<SequenceStep> = {}): SequenceStep => ({
  step: n,
  channel: "email",
  afterPreviousMinutes: n === 1 ? 0 : 3 * DAY,
  subject: n === 1 ? { variable: `subject_${n}` } : null,
  body: { variable: `body_${n}` },
  variants: 1,
  ...over,
});
const planned = (n: number, over: Partial<PlannedStep> = {}): PlannedStep => ({ step: n, channel: "email", delayDays: n === 1 ? null : 3, subject: n === 1, ...over });
const compare = (steps: SequenceStep[], plan: PlannedStep[]) => compareSteps({ sequenceKey: "welcome", steps, asOf: "2026-10-22T00:00:00.000Z" }, plan);
const refused = (r: ReturnType<typeof compare>) => (r.agrees ? [] : r.disagreements);

describe("a sequence's steps against the templates (0064, §5)", () => {
  it("agrees on a plan the provider will run, and says which variable each step renders", () => {
    assert.deepEqual(compare([step(1), step(2), step(3)], [planned(1), planned(2), planned(3)]), {
      agrees: true,
      renders: [{ step: 1, subject: "subject_1", body: "body_1" }, { step: 2, body: "body_2" }, { step: 3, body: "body_3" }],
    });
  });

  it("refuses a different number of steps", () => {
    assert.match(refused(compare([step(1), step(2)], [planned(1)])).join("\n"), /runs 2 step\(s\) of "welcome", and the templates plan 1/);
  });

  it("refuses steps not numbered alike from 1", () => {
    assert.match(refused(compare([step(2)], [planned(2)])).join("\n"), /not numbered alike from 1/);
  });

  it("refuses another channel", () => {
    assert.match(refused(compare([step(1, { channel: "social" })], [planned(1)])).join("\n"), /on "social", the template on "email"/);
  });

  it("refuses another delay, a missing one after the first step, and a wait before the first", () => {
    assert.match(refused(compare([step(1), step(2, { afterPreviousMinutes: 20 })], [planned(1), planned(2)])).join("\n"), /20 minute\(s\) after the step before, the template 3 day\(s\)/);
    assert.match(refused(compare([step(1), step(2)], [planned(1), planned(2, { delayDays: null })])).join("\n"), /gives no delay after the step before it/);
    assert.match(refused(compare([step(1)], [planned(1, { delayDays: 2 })])).join("\n"), /waits 2 day\(s\) before the first step/);
    assert.equal(compare([step(1)], [planned(1, { delayDays: 0 })]).agrees, true);
  });

  it("refuses a step the provider chooses a variant for at send time", () => {
    assert.match(refused(compare([step(1, { variants: 2 })], [planned(1)])).join("\n"), /chooses between 2 variants/);
  });

  it("refuses copy written at the provider, in a body or a subject", () => {
    assert.match(refused(compare([step(1, { body: { written: "text of its own" } })], [planned(1)])).join("\n"), /its body is copy written at the provider/);
    assert.match(refused(compare([step(1, { subject: { written: "text of its own" } })], [planned(1)])).join("\n"), /its subject is copy written at the provider/);
  });

  it("refuses a subject on one side only", () => {
    assert.match(refused(compare([step(1, { subject: null })], [planned(1)])).join("\n"), /the template writes a subject, and the provider sends the step with none/);
    assert.match(refused(compare([step(1)], [planned(1, { subject: false })])).join("\n"), /the provider renders a subject, and the template writes none/);
  });

  it("refuses two steps that render one variable", () => {
    assert.match(refused(compare([step(1), step(2, { body: { variable: "body_1" } })], [planned(1), planned(2)])).join("\n"), /step 2's body renders the variable "body_1", which step 1's body renders too/);
  });
});
