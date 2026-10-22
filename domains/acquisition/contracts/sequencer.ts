/**
 * acquisition/contracts — the outreach tool, on every channel it reaches.
 *
 * The engine owns the copy, the variant and the decision to send; the
 * sequencer owns delivery, timing and the mailbox or profile. Nothing here
 * lets a caller author a sequence or edit a step: a message that exists only
 * in the provider is a message no experiment can attribute, and doctrine 1
 * puts what is being tried in the core.
 *
 * One contract for every channel, not one per channel (decision 0014). An
 * adapter declares the channels it serves — values from the `channels` the
 * enabled domains declare — and is asked about one channel at a time, except
 * by `suppress`, which is never about one channel: a person suppressed on one
 * channel and reachable on another is a hole in protection, not a scope.
 *
 * Stopping someone is why this contract exists rather than a
 * fire-and-forget send, and it takes two acts that are not the same
 * (decision 0057, which supersedes 0011 in part):
 *
 * - `withdraw` suspends one person in one sequence and reads it back; its
 *   caller records the suspension in the enrolment registry (0051). It is
 *   the act 0057 keeps 0004's promise with — an account that becomes
 *   protected after enrolment is stopped — for the people this engine
 *   enrolled, and the one an opt-out and an erasure are to call (0051,
 *   0056).
 * - `suppress` lists a person or a whole account at the provider, to be
 *   refused on every channel, including colleagues this engine never
 *   enrolled; what the listing stops is the provider's. It goes
 *   beyond that promise, and is defence in depth, not the record (0012): it
 *   writes nothing in the registry, and a provider's blocklist may be
 *   emptied in one request, as the shipped adapter's can.
 *
 * A single message is a one-step sequence. There is no `send` here, so that
 * there is one path and one place where suppression is checked.
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey } from "@werunfoundry/core/identity";
import type { ValidationIssue } from "@werunfoundry/core/manifest/types";

import type { InboundEvent } from "./inbound.js";

/** The mailbox or profile a touch leaves from. Capacity is per sender and channel. */
export interface SenderRef {
  /** The provider's identifier for the sender. */
  externalId: string;
  /** For the log and for human reading. Never used for matching. */
  label?: string;
}

export interface Enrolment {
  /**
   * Supplied by the caller: the caller knows what "the same" means.
   *
   * A provider may have a coarser idea of sameness of its own — one
   * enrolment per person per sequence, whatever the key. Replaying the same
   * key returns the enrolment it made. A different key that lands on an
   * enrolment the provider already holds is `conflict`, never a silent
   * success: the caller asked for something new and did not get it.
   */
  idempotencyKey: string;
  /** The sequence as the instance declared it, not as the provider names it. */
  sequenceKey: string;
  /**
   * The channel this enrolment is for — one the adapter declares. An adapter
   * asked for a channel it does not serve refuses as `invalid`.
   */
  channel: string;
  /**
   * Who it must leave from. Optional, because some providers choose the
   * sender themselves, rotating across a pool the sequence owns. An adapter
   * that cannot honour an explicit sender refuses the enrolment as `invalid`
   * rather than accepting it and sending from someone else.
   */
  sender?: SenderRef;
  /**
   * Who (decision 0013). The adapter reads the keys its channel reaches
   * people by; an identity without one is refused as `invalid`, never
   * enrolled under a guess.
   */
  person: Identity;
  /** For the provider's templates and for humans. Never used for matching. */
  display?: { fullName?: string };
  /**
   * Values substituted into the steps. The engine renders what it can itself;
   * what remains here is what the provider must resolve at send time.
   */
  variables?: Record<string, string>;
  /** Carried through so a reply can be attributed without a join table. */
  attribution?: { experimentSlug?: string; variant?: string; runId: string };
}

export type EnrolmentState =
  | "active"
  | "paused"
  /**
   * Enrolled, and waiting on a precondition the adapter declared for this
   * channel — a connection accepted before a message can be sent. Not
   * failed, and not yet reaching anyone.
   */
  | "awaiting_precondition"
  | "finished"
  | "stopped"
  | "bounced"
  /**
   * The person opted out. Not folded into `stopped`: an opt-out is a fact the
   * engine must act on everywhere, and a state that hides it hides it from
   * everything that reads it.
   */
  | "unsubscribed"
  | "unknown";

export interface EnrolmentStatus {
  state: EnrolmentState;
  sequenceKey?: string;
  channel?: string;
  sender?: SenderRef;
  /** Which step the person is on, when the provider exposes it. */
  stepIndex?: number;
  /** For `awaiting_precondition`: which of the declared preconditions are not met yet. */
  pending?: string[];
  /**
   * The idempotency key the provider's record carries for this enrolment,
   * as the read found it — what tells the kernel the record is the
   * enrolment it made, not another one under the same address (0060).
   * Absent when nothing was found, or when the record carries no key: then
   * the kernel cannot tell its enrolment from someone else's, and does not
   * take it as its own. Never the key of the request, which carries none.
   */
  idempotencyKey?: string;
  /**
   * When the read this answer rests on was made (0051: every answer carries
   * the time of its read). Never the provider's own modification time, which
   * every other change to the record moves too.
   */
  asOf: string;
}

/**
 * One limit on one action, in that action's own unit — an email channel
 * counts messages, an invitation channel invitations — over one period.
 */
export interface CapacityLimit {
  /** What is counted, e.g. `messages`, `invitations`. */
  unit: string;
  /**
   * The period the limit is counted over (decision 0020). Closed, because the
   * engine plans against it and cannot plan against a word it does not know.
   */
  window: "hour" | "day" | "week" | "month";
  /**
   * When the count starts again, when the provider says. Absent for a
   * rolling window, which has no single reset, and when the provider does
   * not say.
   */
  resetsAt?: string;
  limit?: number;
  used?: number;
  remaining?: number;
}

/**
 * Everything that limits a sender on one channel, at once (decision 0020).
 * An account commonly carries several limits on the same action — a weekly
 * ceiling and a daily pace — and an adapter reports every one it knows of
 * rather than choosing. Two channels' numbers are never added together.
 */
export interface Capacity {
  sender: SenderRef;
  channel: string;
  /** Never empty. All of them count the same action, in the same unit. */
  limits: CapacityLimit[];
  asOf: string;
}

/**
 * What a sender can still do on a channel: the tightest of its limits.
 *
 * Unknown — never the loosest of the others — if any limit does not say
 * what is left: a limit nobody can read may be the one that binds. Unknown
 * too if there is no limit, or if limits count different things, because
 * the smallest of two numbers in two units means nothing.
 */
export function remainingOf(capacity: Capacity): { remaining: number; binding: CapacityLimit } | { unknown: string } {
  const limits = capacity.limits;
  if (limits.length === 0) return { unknown: "the provider reported no limit" };
  if (new Set(limits.map((l) => l.unit)).size > 1) {
    return { unknown: `the limits count different things (${[...new Set(limits.map((l) => l.unit))].join(", ")})` };
  }
  const silent = limits.find((l) => l.remaining === undefined);
  if (silent) return { unknown: `the provider did not say what is left of its ${silent.window} limit` };
  const binding = limits.reduce((a, b) => ((b.remaining as number) < (a.remaining as number) ? b : a));
  return { remaining: binding.remaining as number, binding };
}

/** What a withdrawal found, and what the provider showed afterwards. */
export interface Withdrawal {
  /** Whether the person was in the sequence at the provider at all. */
  found: boolean;
  /**
   * The provider's record of the person after the act, as the read-back
   * returned it — what the registry keeps as the suspension's read-back
   * (0051). It may name the person; erasure replaces it (0053). Absent when
   * nothing was found, and in a dry run, which writes nothing to read back.
   */
  readBack?: Record<string, unknown>;
  /**
   * The idempotency key of the enrolment the provider's record carries, as
   * the read found it (0060). Absent when nothing was found, or when the
   * record carries no key. The person is stopped by address either way; the
   * key is what lets the kernel say the stopped record is its enrolment.
   */
  idempotencyKey?: string;
  /** When the read-back was made. */
  asOf: string;
}

/** What the unsubscribes pull read (0051's verb 4). */
export interface UnsubscribesRead {
  /** Each an `acquisition.unsubscribe` event, about one person, from one of the adapter's sequences. */
  items: InboundEvent[];
  /** Whether every page was read. */
  complete: boolean;
}

/**
 * What one step renders (decision 0064): a variable, which the kernel fills
 * with the message it wrote, or copy written at the provider, which the
 * kernel did not write and refuses.
 */
export type StepCopy = { variable: string } | { written: string };

/** One step of a sequence, as the provider will run it (0064's steps verb). */
export interface SequenceStep {
  /** 1 for the first step, as a template counts its `step`. */
  step: number;
  channel: string;
  /** How long after the previous step this one leaves, in minutes; 0 for the first. */
  afterPreviousMinutes: number;
  /** `null`: the step has no subject of its own, and goes as a reply in the thread. */
  subject: StepCopy | null;
  body: StepCopy;
  /** How many variants the provider chooses between at send time. The kernel writes one message per step. */
  variants: number;
}

/** A sequence's steps, read from the provider (0064). */
export interface SequenceSteps {
  sequenceKey: string;
  steps: SequenceStep[];
  /** When the read was made. */
  asOf: string;
}

/** What a suppression reached. */
export interface Suppression {
  /** The keys the provider now refuses, including those it already refused. */
  applied: IdentityKey[];
  /** Keys of the identity this provider has no way to act on. */
  notApplicable: IdentityKey[];
  /** When the last read this answer rests on was made — the read-back, or the read before it when nothing was written (0051). */
  asOf: string;
}

/* -------------------------------------------------------------------------- */
/* What an adapter declares it can do (decision 0051)                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether an adapter serves one of the four verbs the kernel needs. Not
 * serving it is a fact of the system, reported as such — never an error,
 * never smoothed into a success — and a partial service says why.
 */
export type Serves =
  | { serves: "yes" }
  | { serves: "partially"; why: string }
  | { serves: "no"; why: string };

/**
 * A verb this contract has no method for (decision 0054): it can only be
 * declared not served. A declaration is a precondition, never evidence, and
 * one that serves a verb nothing can call is a promise with nothing behind
 * it. When the contract gains the method, the verb takes `Serves`.
 */
export type NotServed = { serves: "no"; why: string };

/** What a way of suspending costs the person, in 0051's vocabulary. */
export const PERSON_COSTS = [
  "provider_status_stays_active", // the provider's status keeps reading active
  "sequence_link_lost", // the provider's link to the original sequence is lost
  "provider_record_lost", // the provider's record of the person is lost
  "irreversible", // the act cannot be undone
] as const;
export type PersonCost = (typeof PERSON_COSTS)[number];

/** What a way of suspending costs the sequence everyone else is in. */
export const SEQUENCE_COSTS = [
  "shared_state_changes", // the shared sequence's own state changes, for everyone else in it
] as const;
export type SequenceCost = (typeof SEQUENCE_COSTS)[number];

/**
 * How long after a suspension's read-back a step already picked to send can
 * still leave. A touch inside it is in the gap, not a breach. It carries the
 * measurement it rests on and its date, or says it is unknown: a delay
 * nobody measured is not a delay, whatever number would look reasonable.
 */
export type SuspensionGap =
  | { known: true; minutes: number; basis: string; measuredOn: string }
  | { known: false; why: string };

interface SuspensionMethod {
  /** The way the provider is asked to stop, as the adapter names it. */
  method: string;
  /** Empty lists are a declaration too: no cost, on that side. */
  costs: { person: readonly PersonCost[]; sequence: readonly SequenceCost[] };
  gap: SuspensionGap;
  /**
   * Set when the adapter does not take the least destructive way its
   * provider offers among those that assert nothing about the person: which
   * one it passed over, and why.
   */
  notTheLeastDestructive?: { available: string; why: string };
}

export type SuspendDeclaration =
  | ({ serves: "yes" } & SuspensionMethod)
  | ({ serves: "partially"; why: string } & SuspensionMethod)
  | { serves: "no"; why: string };

/**
 * A claim about what the provider does, proved the way 0051 asks: by what
 * was measured, and when. A claim nobody measured is not made; the
 * declaration that would carry it is left out, and its default holds.
 */
interface Measured {
  /** What was measured, and how. */
  basis: string;
  /** When, as YYYY-MM-DD. */
  measuredOn: string;
}

/**
 * The form the provider delivers a body in (decision 0065). Undeclared, the
 * kernel writes a body that reads the same in either: no markup, no line
 * break that carries meaning, single spaces, bare URLs — nothing is lost
 * whether delivery removes markup or collapses blanks.
 */
export type DeliveredForm = { form: "plain_text" | "html" } & Measured;

/**
 * How long, after the call that returns the way out, before the provider's
 * first step can leave (decision 0065). A step leaving inside it carries no
 * way out. Measured, or said to be unknown.
 */
export type WayOutWindow = ({ known: true; seconds: number } & Measured) | { known: false; why: string };

/**
 * The way out the provider offers inside a body, and when it is known
 * (decision 0065). Undeclared, it is `none`: the kernel writes none, and the
 * enrolment records that its body carried none because the adapter said
 * nothing.
 */
export type WayOutDeclaration =
  /** A provider with no such thing — a channel without unsubscribe links. A fact, not a failure. */
  | { offered: "none"; why: string }
  /** Known before the first call: the body goes complete, in one call. */
  | { offered: "known_before"; what: string }
  /** Known once the adapter's call returns: the kernel writes it in after, inside the window. */
  | { offered: "known_after"; what: string; window: WayOutWindow };

/**
 * Whether the provider classes a reply asking to stop as an unsubscribe
 * (decision 0065). Undeclared, it does not: nothing said is not "yes", and a
 * person reads the replies at a terminal. `yes` is proved, never assumed.
 */
export type StopClassing = ({ classes: "yes" } & Measured) | { classes: "no"; why: string };

/**
 * Everything an adapter says about itself, read without calling the
 * provider: a constant on the adapter, like its channels.
 */
export interface SequencerDeclaration {
  enrol: Serves;
  /** 0051's verb 2. No method in this contract yet. */
  pullTouches: NotServed;
  suspend: SuspendDeclaration;
  /** 0051's verb 4: `pullUnsubscribes`. */
  pullUnsubscribes: Serves;
  /** Decision 0064's steps verb: `readSteps`. Absent: not served — nothing said is not "yes". */
  readSteps?: Serves;
  /** Decision 0065. Absent: a body that reads the same in either form. */
  deliveredForm?: DeliveredForm;
  /** Decision 0065. Absent: no way out, recorded as such. */
  wayOut?: WayOutDeclaration;
  /** Decision 0065. Absent: the provider does not class a stop. */
  classesStop?: StopClassing;
}

/**
 * What the kernel holds of 0065's three declarations once their defaults
 * apply — the least an adapter's silence allows (decision 0065).
 */
export interface Delivery {
  /** `either` when undeclared: a body that reads the same as plain text and as HTML. */
  form: "plain_text" | "html" | "either";
  wayOut: WayOutDeclaration;
  /** Whether the way out was declared, or is the default for an adapter that said nothing. */
  wayOutDeclared: boolean;
  classesStop: boolean;
}

const VERBS = ["enrol", "pullTouches", "suspend", "pullUnsubscribes"] as const;
/**
 * The method behind each verb, or none (decision 0054). Suspension is
 * `withdraw`: 0011 named the act so, and 0051 calls it suspension. The type
 * above says the same for an adapter the compiler sees; this says it for one
 * it never saw, written in plain JavaScript (0005).
 */
const METHOD: Record<(typeof VERBS)[number], "enrol" | "withdraw" | "pullUnsubscribes" | null> = {
  enrol: "enrol",
  pullTouches: null,
  suspend: "withdraw",
  pullUnsubscribes: "pullUnsubscribes",
};
const SERVES = new Set(["yes", "partially", "no"]);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Everything wrong with a declaration, at once. Checked at run time as well
 * as by the compiler: an instance's adapter may be plain JavaScript (0005).
 *
 * Given the adapter, it reads the adapter too (decision 0054): a verb
 * declared served whose method is not a function on it is refused. No check
 * proves that a method works; that is the read-back's, act by act (0051).
 *
 * **Without the adapter, it checks the declaration's form and nothing
 * more.** An empty answer then says the declaration is well formed, not
 * that the adapter can do what it declares: a declaration that serves
 * suspension on an adapter with no `withdraw` passes. That partial call
 * exists for a caller that holds only the declaration. `readDeclaration`,
 * the gate before an enrolment or a suspension, always passes the adapter,
 * and that is what bounds the gap.
 */
export function checkDeclaration(declaration: unknown, adapter?: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (at: string, message: string) => issues.push({ severity: "error", at, message });
  if (typeof declaration !== "object" || declaration === null) {
    error("declares", "not an object");
    return issues;
  }
  const d = declaration as Record<string, unknown>;
  for (const verb of VERBS) {
    const v = d[verb] as Record<string, unknown> | undefined;
    if (typeof v !== "object" || v === null) {
      error(verb, "missing: every verb is declared, served or not");
      continue;
    }
    if (!SERVES.has(v.serves as string)) {
      error(`${verb}.serves`, `"${String(v.serves)}" is not yes, partially or no`);
      continue;
    }
    if (v.serves !== "yes" && !isText(v.why)) error(`${verb}.why`, `a verb served ${v.serves === "no" ? "not at all" : "partially"} says why`);
    const method = METHOD[verb];
    if (v.serves !== "no" && method === null) {
      error(`${verb}.serves`, "the contract has no method for this verb, so it can only be declared not served (decision 0054)");
      continue;
    }
    if (v.serves !== "no" && method !== null && adapter !== undefined && typeof (adapter as Record<string, unknown> | null)?.[method] !== "function") {
      error(verb, `declared served, but \`${method}\` is not a function on the adapter (decision 0054)`);
    }
    if (verb !== "suspend" || v.serves === "no") continue;

    if (!isText(v.method)) error("suspend.method", "a suspension names the way it stops the person");
    const costs = v.costs as { person?: unknown; sequence?: unknown } | undefined;
    if (!costs || !Array.isArray(costs.person) || !Array.isArray(costs.sequence)) {
      error("suspend.costs", "declares both sides, the person and the shared sequence, even when a side costs nothing");
    } else {
      for (const c of costs.person) if (!(PERSON_COSTS as readonly unknown[]).includes(c)) error("suspend.costs.person", `"${String(c)}" is not in 0051's vocabulary`);
      for (const c of costs.sequence) if (!(SEQUENCE_COSTS as readonly unknown[]).includes(c)) error("suspend.costs.sequence", `"${String(c)}" is not in 0051's vocabulary`);
    }
    const gap = v.gap as Record<string, unknown> | undefined;
    if (!gap || typeof gap.known !== "boolean") {
      error("suspend.gap", "declared, as a measured delay or as unknown");
    } else if (gap.known) {
      if (typeof gap.minutes !== "number" || !Number.isFinite(gap.minutes) || gap.minutes < 0) error("suspend.gap.minutes", "a delay is a number of minutes, zero or more");
      if (!isText(gap.basis)) error("suspend.gap.basis", "a measured delay says what it was measured from");
      if (typeof gap.measuredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(gap.measuredOn) || Number.isNaN(Date.parse(gap.measuredOn))) {
        error("suspend.gap.measuredOn", "a measured delay carries the date it was measured, as YYYY-MM-DD");
      }
    } else if (!isText(gap.why)) {
      error("suspend.gap.why", "an unknown delay says why it is unknown");
    }
    const passed = v.notTheLeastDestructive as Record<string, unknown> | undefined;
    if (passed !== undefined && (!isText(passed.available) || !isText(passed.why))) {
      error("suspend.notTheLeastDestructive", "names the way passed over, and why");
    }
  }

  // Decision 0064's steps verb: optional, and not served when left out. One
  // that is declared is read as the four above are, method included (0054).
  if (d.readSteps !== undefined) {
    const v = d.readSteps as Record<string, unknown> | null;
    if (typeof v !== "object" || v === null) error("readSteps", "not an object; leave it out for not served");
    else if (!SERVES.has(v.serves as string)) error("readSteps.serves", `"${String(v.serves)}" is not yes, partially or no`);
    else {
      if (v.serves !== "yes" && !isText(v.why)) error("readSteps.why", `a verb served ${v.serves === "no" ? "not at all" : "partially"} says why`);
      if (v.serves !== "no" && adapter !== undefined && typeof (adapter as Record<string, unknown> | null)?.readSteps !== "function") {
        error("readSteps", "declared served, but `readSteps` is not a function on the adapter (decision 0054)");
      }
    }
  }

  // Decision 0065: each is optional, and its default holds when it is left
  // out. One that is present says something, so it must be readable, and a
  // claim about the provider carries what it was measured from.
  const measured = (at: string, m: Record<string, unknown>) => {
    if (!isText(m.basis)) error(`${at}.basis`, "a claim about the provider says what it was measured from (decision 0065)");
    if (typeof m.measuredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.measuredOn) || Number.isNaN(Date.parse(m.measuredOn))) {
      error(`${at}.measuredOn`, "a claim about the provider carries the date it was measured, as YYYY-MM-DD (decision 0065)");
    }
  };
  if (d.deliveredForm !== undefined) {
    const f = d.deliveredForm as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null) error("deliveredForm", "not an object; leave it out to keep the default");
    else {
      if (f.form !== "plain_text" && f.form !== "html") error("deliveredForm.form", `"${String(f.form)}" is not plain_text or html`);
      measured("deliveredForm", f);
    }
  }
  if (d.wayOut !== undefined) {
    const w = d.wayOut as Record<string, unknown> | null;
    if (typeof w !== "object" || w === null) error("wayOut", "not an object; leave it out to keep the default");
    else if (w.offered === "none") {
      if (!isText(w.why)) error("wayOut.why", "a provider that offers no way out in a body says why");
    } else if (w.offered === "known_before" || w.offered === "known_after") {
      if (!isText(w.what)) error("wayOut.what", "names the way out the provider offers");
      if (w.offered === "known_after") {
        const win = w.window as Record<string, unknown> | undefined;
        if (!win || typeof win.known !== "boolean") error("wayOut.window", "declared, as a measured window or as unknown (decision 0065)");
        else if (win.known) {
          if (typeof win.seconds !== "number" || !Number.isFinite(win.seconds) || win.seconds < 0) error("wayOut.window.seconds", "a window is a number of seconds, zero or more");
          measured("wayOut.window", win);
        } else if (!isText(win.why)) error("wayOut.window.why", "an unknown window says why it is unknown");
      }
    } else error("wayOut.offered", `"${String(w.offered)}" is not none, known_before or known_after`);
  }
  if (d.classesStop !== undefined) {
    const c = d.classesStop as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null) error("classesStop", "not an object; leave it out to keep the default");
    else if (c.classes === "yes") measured("classesStop", c);
    else if (c.classes === "no") {
      if (!isText(c.why)) error("classesStop.why", "says why");
    } else error("classesStop.classes", `"${String(c.classes)}" is not yes or no`);
  }
  return issues;
}

/**
 * 0065's three declarations with their defaults applied: what an adapter's
 * silence allows is the least — a body that reads the same in either form,
 * no way out, a provider that does not class a stop. For a declaration
 * `checkDeclaration` accepted.
 */
export function deliveryOf(d: SequencerDeclaration): Delivery {
  return {
    form: d.deliveredForm?.form ?? "either",
    wayOut: d.wayOut ?? { offered: "none", why: "the adapter does not say (decision 0065)" },
    wayOutDeclared: d.wayOut !== undefined,
    classesStop: d.classesStop?.classes === "yes",
  };
}

const deliveryLines = (d: SequencerDeclaration): string[] => {
  const lines: string[] = [];
  const f = d.deliveredForm;
  lines.push(
    f
      ? `  delivers a body as: ${f.form === "plain_text" ? "plain text" : "HTML"} (${f.basis}, measured ${f.measuredOn})`
      : "  delivers a body as: not declared — the kernel writes a body that reads the same in either form (decision 0065)",
  );
  const w = d.wayOut;
  if (!w) lines.push("  a way out in the body: not declared — none is written, and each enrolment records that its body carried none (decision 0065)");
  else if (w.offered === "none") lines.push(`  a way out in the body: none — ${w.why}`);
  else if (w.offered === "known_before") lines.push(`  a way out in the body: ${w.what}, known before the first call`);
  else {
    lines.push(`  a way out in the body: ${w.what}, known only after the call`);
    lines.push(
      w.window.known
        ? `    window before a first step can leave: ${w.window.seconds} seconds (${w.window.basis}, measured ${w.window.measuredOn})`
        : `    window before a first step can leave: unknown — ${w.window.why}`,
    );
  }
  const c = d.classesStop;
  lines.push(
    c?.classes === "yes"
      ? `  a reply asking to stop: classed by the provider as an unsubscribe (${c.basis}, measured ${c.measuredOn})`
      : `  a reply asking to stop: not classed by the provider${c ? ` — ${c.why}` : " — not declared, so held not to be (decision 0065)"}; a person records it at a terminal`,
  );
  return lines;
};

const SAID: Record<PersonCost | SequenceCost, string> = {
  provider_status_stays_active: "the provider's status keeps reading active",
  sequence_link_lost: "the link to the original sequence is lost at the provider",
  provider_record_lost: "the provider's record of the person is lost",
  irreversible: "it cannot be undone",
  shared_state_changes: "the sequence's own state changes, for everyone else in it",
};

const served = (s: Serves) => (s.serves === "yes" ? "serves" : s.serves === "partially" ? `serves partially — ${s.why}` : `does not serve — ${s.why}`);

/**
 * What an adapter declares, as the lines a command prints before it enrols
 * anyone, and whether the kernel may enrol through it. It may only when the
 * adapter declares, validly, that it can suspend: a declaration that is
 * missing or malformed says nothing, and nothing is not "can suspend".
 */
export function readDeclaration(
  sequencer: Pick<Sequencer, "provider" | "declares"> & { enrol?: unknown; withdraw?: unknown },
): { suspends: boolean; lines: string[]; refusal?: string; delivery?: Delivery } {
  const head = `the sequencer "${sequencer.provider}" declares (decision 0051):`;
  if (sequencer.declares === undefined) {
    const refusal = `the sequencer "${sequencer.provider}" declares nothing about what it can do; the kernel enrols only through one that declares it can suspend (decision 0051)`;
    return { suspends: false, lines: [`the sequencer "${sequencer.provider}" declares nothing (decision 0051)`], refusal };
  }
  const issues = checkDeclaration(sequencer.declares, sequencer);
  if (issues.length > 0) {
    const refusal = `the sequencer "${sequencer.provider}" declares itself in a form the kernel cannot read: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`;
    return { suspends: false, lines: [head, ...issues.map((i) => `  ✖ ${i.at}: ${i.message}`)], refusal };
  }
  const d = sequencer.declares;
  const lines = [
    head,
    `  enrol: ${served(d.enrol)}`,
    `  pull the touches: ${served(d.pullTouches)}`,
    `  pull the unsubscribes: ${served(d.pullUnsubscribes)}`,
    `  read a sequence's steps: ${served(d.readSteps ?? { serves: "no", why: "the adapter does not say (decision 0064)" })}`,
  ];
  const delivery = deliveryOf(d);
  const s = d.suspend;
  if (s.serves === "no") {
    lines.push(`  suspend one person: does not serve — ${s.why}`, ...deliveryLines(d));
    const refusal = `the sequencer "${sequencer.provider}" cannot suspend one person in a sequence (${s.why}); the kernel does not enrol through it (decision 0051)`;
    return { suspends: false, lines, refusal, delivery };
  }
  lines.push(`  suspend one person: ${s.serves === "yes" ? "serves" : `serves partially — ${s.why}`}, by ${s.method}`);
  const costs = (list: readonly (PersonCost | SequenceCost)[]) => (list.length ? list.map((c) => SAID[c]).join("; ") : "none declared");
  lines.push(`    costs the person: ${costs(s.costs.person)}`);
  lines.push(`    costs the shared sequence: ${costs(s.costs.sequence)}`);
  if (s.notTheLeastDestructive) lines.push(`    not the least destructive way: ${s.notTheLeastDestructive.available} was passed over — ${s.notTheLeastDestructive.why}`);
  lines.push(
    s.gap.known
      ? `    gap: ${s.gap.minutes} minutes after the read-back (${s.gap.basis}, measured ${s.gap.measuredOn})`
      : `    gap: unknown — ${s.gap.why}; every touch after a suspension is reported, neither a breach nor accepted`,
  );
  lines.push(...deliveryLines(d));
  return { suspends: true, lines, delivery };
}

export interface Sequencer extends Contract {
  /** The channels this adapter serves, from the enabled domains' `channels`. */
  readonly channels: readonly string[];

  /**
   * What this adapter can and cannot do (decision 0051), read without
   * calling the provider. Optional so that an adapter written before it
   * still loads; but an adapter that declares nothing is one the kernel does
   * not enrol through — nothing said is not "can suspend".
   */
  readonly declares?: SequencerDeclaration;

  /**
   * Per channel, what an enrolment waits on before it reaches anyone — the
   * names are the adapter's, for the engine to plan with and for `pending`
   * to report. A channel absent here has none.
   */
  readonly preconditions?: Readonly<Record<string, readonly string[]>>;

  enrol(
    enrolment: Enrolment,
    ctx: CallContext,
  ): Promise<CallResult<EnrolmentStatus>>;

  /**
   * Suspend one person in one sequence (0051's verb 3; 0011 named it
   * withdraw): no further step of that sequence reaches them. The adapter
   * does it the way its declaration names, reads the provider back, and
   * answers only with what that read shows (0051): a write whose effect the
   * read does not show is an error, never a success.
   *
   * What protection after enrolment rests on, for the people this engine
   * enrolled (0057): read back here, and recorded in the registry by the
   * caller.
   *
   * Idempotent: withdrawing someone who is not enrolled succeeds, with
   * `found: false`; withdrawing someone already withdrawn succeeds again.
   */
  withdraw(
    request: {
      idempotencyKey: string;
      person: Identity;
      sequenceKey: string;
      /** For the audit trail. Never interpreted by the provider. */
      reason: string;
    },
    ctx: CallContext,
  ): Promise<CallResult<Withdrawal>>;

  /**
   * 0051's verb 4: every unsubscribe the provider holds for the sequences
   * this adapter is bound to, as `acquisition.unsubscribe` events (0017's
   * shape), so that the kernel records them as it records any opt-out.
   *
   * Read in full each time, not after a cursor: a provider that cannot
   * filter its unsubscribes by date gives no point to read after, and a
   * cursor over another order would miss an old lead that unsubscribes
   * late. Each event's `providerEventId` makes a second read of it a
   * replay, stored once. `complete: false` says the read stopped before the
   * end — a bound, or a page that failed after others — and the kernel says
   * so rather than take a part for the whole.
   *
   * Optional: an adapter that does not serve the verb declares so, and has
   * no method (0054).
   */
  pullUnsubscribes?(ctx: CallContext): Promise<CallResult<UnsubscribesRead>>;

  /**
   * Decision 0064's steps verb: the steps the provider will run for a
   * sequence, read from it — each step's channel, its delay after the one
   * before, and what it renders. The kernel compares them with the
   * templates of the messages it wrote before it enrols anyone: a plan the
   * provider will not run caps nothing. Reads only.
   *
   * Optional: an adapter that does not serve the verb declares so, and has
   * no method (0054).
   */
  readSteps?(sequenceKey: string, ctx: CallContext): Promise<CallResult<SequenceSteps>>;

  /**
   * Stop this provider reaching a person or a whole account, on every
   * channel it serves, at once, and keep it stopped. Defence in depth
   * (0012, 0057): it reaches people this engine never enrolled, and records
   * nothing in the registry; protection after enrolment rests on
   * `withdraw`, and this goes beyond it. Takes an identity, not a string:
   * the adapter applies every key of it that it can act on, and says which.
   *
   * An identity with no key this provider can act on is refused as
   * `invalid`: a suppression that applied nothing has protected nothing, and
   * must not look like one that did.
   *
   * On success, every key reported applied reads back as listed at the
   * provider, as of the read `asOf` names (0051). What that listing then
   * stops is the provider's: defence in depth, not a guarantee (0012).
   * Refusing future enrolments is the engine's job, which re-checks
   * protection at enrolment. Idempotent.
   */
  suppress(
    request: {
      idempotencyKey: string;
      target: Identity;
      /** For the audit trail. Never interpreted by the provider. */
      reason: string;
    },
    ctx: CallContext,
  ): Promise<CallResult<Suppression>>;

  /**
   * One enrolment: this person, in this sequence. A person can be in several
   * sequences at once, and a status for "the person" would have to pick one.
   * A read that finds no enrolment returns `state: "unknown"`, not an error.
   */
  status(
    request: { person: Identity; sequenceKey: string },
    ctx: CallContext,
  ): Promise<CallResult<EnrolmentStatus>>;

  /** A sender's capacity on one of this adapter's channels. */
  capacity(
    request: { sender: SenderRef; channel: string },
    ctx: CallContext,
  ): Promise<CallResult<Capacity>>;
}
