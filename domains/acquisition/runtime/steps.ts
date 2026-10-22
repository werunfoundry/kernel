/**
 * acquisition/runtime — a sequence's steps, as the provider will run them,
 * held against the templates of the messages the kernel wrote (decision
 * 0064, section 5).
 *
 * The kernel writes every step's message, and the provider renders each one
 * from a variable. The plan the cap counts is the templates'; the plan that
 * runs is the provider's. When the two disagree the enrolment is refused: a
 * plan the provider will not run caps nothing. They agree when they have:
 *
 * - **as many steps**, numbered alike from 1;
 * - **the same channel**, step by step;
 * - **the same delay** after the previous step. A template counts it in
 *   whole days (`delay_days`); the first step waits for nothing, and a later
 *   one with no delay is a plan the kernel does not hold;
 * - **one variant**: the kernel writes one message per step, and a provider
 *   that chooses between several at send time sends copy it chose;
 * - **only variables**, the kernel's: copy written at the provider is copy
 *   nobody here wrote (0064, *Rules out*). A step renders a subject exactly
 *   when its template has one;
 * - **a variable of its own** for each subject and body: two steps rendering
 *   one variable would send one message twice.
 *
 * Reads nothing and writes nothing: the caller reads the steps and the
 * templates, and refuses on what this returns.
 */

import type { SequenceSteps } from "../contracts/sequencer.js";

/** A template, as the comparison reads it: one per step of the plan. */
export interface PlannedStep {
  step: number;
  channel: string;
  /** `template.delay_days`: after the previous step, in whole days. */
  delayDays: number | null;
  /** Whether the template writes a subject. */
  subject: boolean;
}

/** What each step renders, by variable, once the plan and the provider agree. */
export interface StepRender {
  step: number;
  subject?: string;
  body: string;
}

export type StepsAgreement = { agrees: true; renders: StepRender[] } | { agrees: false; disagreements: string[] };

const DAY_MINUTES = 24 * 60;

export function compareSteps(read: SequenceSteps, plan: readonly PlannedStep[]): StepsAgreement {
  const disagreements: string[] = [];
  const steps = [...read.steps].sort((a, b) => a.step - b.step);
  const planned = [...plan].sort((a, b) => a.step - b.step);
  if (steps.length !== planned.length) {
    disagreements.push(`the provider runs ${steps.length} step(s) of "${read.sequenceKey}", and the templates plan ${planned.length}`);
  }
  const used = new Map<string, string>();
  const variable = (at: string, name: string) => {
    const before = used.get(name);
    if (before) disagreements.push(`${at} renders the variable "${name}", which ${before} renders too: one message would be sent twice`);
    else used.set(name, at);
  };
  const renders: StepRender[] = [];
  for (let i = 0; i < Math.min(steps.length, planned.length); i++) {
    const p = steps[i]!;
    const t = planned[i]!;
    const at = `step ${t.step}`;
    if (p.step !== t.step || t.step !== i + 1) {
      disagreements.push(`${at}: the steps are not numbered alike from 1 (the provider's is ${p.step})`);
      continue;
    }
    if (p.channel !== t.channel) disagreements.push(`${at}: the provider sends it on "${p.channel}", the template on "${t.channel}"`);
    if (i === 0) {
      if (t.delayDays !== null && t.delayDays !== 0) disagreements.push(`${at}: the template waits ${t.delayDays} day(s) before the first step, which waits for nothing`);
    } else if (t.delayDays === null) {
      disagreements.push(`${at}: the template gives no delay after the step before it`);
    } else if (p.afterPreviousMinutes !== t.delayDays * DAY_MINUTES) {
      disagreements.push(`${at}: the provider sends it ${p.afterPreviousMinutes} minute(s) after the step before, the template ${t.delayDays} day(s)`);
    }
    if (p.variants !== 1) disagreements.push(`${at}: the provider chooses between ${p.variants} variants at send time; the kernel writes one message`);
    if ("written" in p.body) disagreements.push(`${at}: its body is copy written at the provider (${p.body.written})`);
    else variable(`${at}'s body`, p.body.variable);
    if (p.subject === null) {
      if (t.subject) disagreements.push(`${at}: the template writes a subject, and the provider sends the step with none`);
    } else if ("written" in p.subject) {
      disagreements.push(`${at}: its subject is copy written at the provider (${p.subject.written})`);
    } else {
      if (!t.subject) disagreements.push(`${at}: the provider renders a subject, and the template writes none`);
      variable(`${at}'s subject`, p.subject.variable);
    }
    if ("variable" in p.body) renders.push({ step: t.step, body: p.body.variable, ...(p.subject && "variable" in p.subject ? { subject: p.subject.variable } : {}) });
  }
  return disagreements.length > 0 ? { agrees: false, disagreements } : { agrees: true, renders };
}
