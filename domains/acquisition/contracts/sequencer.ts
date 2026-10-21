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
  /** When the read-back was made. */
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
 * Everything an adapter says about itself, read without calling the
 * provider: a constant on the adapter, like its channels.
 */
export interface SequencerDeclaration {
  enrol: Serves;
  pullTouches: Serves;
  suspend: SuspendDeclaration;
  pullUnsubscribes: Serves;
}

const VERBS = ["enrol", "pullTouches", "suspend", "pullUnsubscribes"] as const;
const SERVES = new Set(["yes", "partially", "no"]);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Everything wrong with a declaration, at once. Checked at run time as well
 * as by the compiler: an instance's adapter may be plain JavaScript (0005).
 */
export function checkDeclaration(declaration: unknown): ValidationIssue[] {
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
  return issues;
}

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
export function readDeclaration(sequencer: Pick<Sequencer, "provider" | "declares">): { suspends: boolean; lines: string[]; refusal?: string } {
  const head = `the sequencer "${sequencer.provider}" declares (decision 0051):`;
  if (sequencer.declares === undefined) {
    const refusal = `the sequencer "${sequencer.provider}" declares nothing about what it can do; the kernel enrols only through one that declares it can suspend (decision 0051)`;
    return { suspends: false, lines: [`the sequencer "${sequencer.provider}" declares nothing (decision 0051)`], refusal };
  }
  const issues = checkDeclaration(sequencer.declares);
  if (issues.length > 0) {
    const refusal = `the sequencer "${sequencer.provider}" declares itself in a form the kernel cannot read: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`;
    return { suspends: false, lines: [head, ...issues.map((i) => `  ✖ ${i.at}: ${i.message}`)], refusal };
  }
  const d = sequencer.declares;
  const lines = [head, `  enrol: ${served(d.enrol)}`, `  pull the touches: ${served(d.pullTouches)}`, `  pull the unsubscribes: ${served(d.pullUnsubscribes)}`];
  const s = d.suspend;
  if (s.serves === "no") {
    lines.push(`  suspend one person: does not serve — ${s.why}`);
    const refusal = `the sequencer "${sequencer.provider}" cannot suspend one person in a sequence (${s.why}); the kernel does not enrol through it (decision 0051)`;
    return { suspends: false, lines, refusal };
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
  return { suspends: true, lines };
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
