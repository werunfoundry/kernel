/**
 * acquisition/runtime — the cap, judged ahead over a whole plan (decision
 * 0064 §3).
 *
 * Enrolling someone in a sequence of unsolicited steps commits to those
 * touches, at the times the steps' delays set. The cap refuses the
 * enrolment if any window of the cap's length, anywhere on the timeline,
 * would hold more unsolicited touches to the person than the cap allows.
 * The timeline is everything that reaches them:
 *
 * - **what happened**: the unsolicited touches already recorded, by the
 *   touches pull among others, on every channel;
 * - **what is committed**: the steps still planned of their other
 *   enrolments, in any sequence, on any channel — a step whose touch is
 *   recorded counts once, as the touch;
 * - **what this enrolment would add**: its own steps, from now.
 *
 * The count is from the kernel's own commitments, not from the provider's
 * record of sends, which lists a send late: a plan counts a step before it
 * leaves, and the pull only replaces it with what happened.
 *
 * Pure: the caller reads the timeline, and refuses on what this returns.
 */

export interface Cap {
  /** At most this many unsolicited touches… */
  max: number;
  /** …inside any window of this many days. */
  withinDays: number;
}

export type CapJudgement =
  | { within: true; busiest: number }
  | { within: false; count: number; from: Date; to: Date };

const DAY = 24 * 60 * 60 * 1000;

/**
 * Whether `planned` fits beside `already` under the cap. A window that holds
 * none of `planned` is not this enrolment's to judge: what already reaches
 * the person past the cap is history, and refusing a plan that adds nothing
 * to that window would refuse for what it did not do.
 */
export function judgeAhead(already: readonly Date[], planned: readonly Date[], cap: Cap): CapJudgement {
  if (!Number.isInteger(cap.max) || cap.max < 0 || !(cap.withinDays > 0)) throw new Error("a cap is a whole number of touches, at least 0, in a window of more than 0 days");
  const width = cap.withinDays * DAY;
  const all = [...already.map((t) => ({ t: t.getTime(), mine: false })), ...planned.map((t) => ({ t: t.getTime(), mine: true }))].sort((a, b) => a.t - b.t);
  let busiest = 0;
  // A window holding the most points starts at one of them: slide it from each.
  for (let i = 0; i < all.length; i++) {
    let count = 0;
    let mine = false;
    let last = all[i]!.t;
    for (let j = i; j < all.length && all[j]!.t < all[i]!.t + width; j++) {
      count++;
      mine ||= all[j]!.mine;
      last = all[j]!.t;
    }
    if (!mine) continue;
    busiest = Math.max(busiest, count);
    if (count > cap.max) return { within: false, count, from: new Date(all[i]!.t), to: new Date(last) };
  }
  return { within: true, busiest };
}

/** The times a plan's steps leave, from `start`: each after the one before by its delay. */
export function planTimes(start: Date, steps: readonly { afterPreviousMinutes: number }[]): Date[] {
  let at = start.getTime();
  return steps.map((s) => new Date((at += s.afterPreviousMinutes * 60_000)));
}
