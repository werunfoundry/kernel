/**
 * gtm/contracts — the outreach tool, on every channel it reaches.
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
 * `suppress` is as important as `enrol`, and is the reason this contract
 * exists at all rather than a fire-and-forget send. An account can become
 * protected after enrolment (decision 0004); without a way to stop every
 * running sequence reaching it, protection is a promise that holds only until
 * the next step fires. `withdraw` is the narrower, ordinary act — this
 * person, out of this sequence (decision 0011).
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
  /** When the provider last changed this. */
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

/** What a suppression reached. */
export interface Suppression {
  /** The keys the provider now refuses, including those it already refused. */
  applied: IdentityKey[];
  /** Keys of the identity this provider has no way to act on. */
  notApplicable: IdentityKey[];
}

export interface Sequencer extends Contract {
  /** The channels this adapter serves, from the enabled domains' `channels`. */
  readonly channels: readonly string[];

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
   * Take a person out of one sequence. The ordinary act: the experiment
   * ended, the person replied through another channel.
   * Idempotent: withdrawing someone who is not enrolled succeeds.
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
  ): Promise<CallResult<void>>;

  /**
   * Stop this provider reaching a person or a whole account, on every
   * channel it serves, at once, and keep it stopped. What protection needs
   * after enrolment (decision 0004). Takes an identity, not a string: the
   * adapter applies every key of it that it can act on, and says which.
   *
   * An identity with no key this provider can act on is refused as
   * `invalid`: a suppression that applied nothing has protected nothing, and
   * must not look like one that did.
   *
   * On success, no further step of an already running sequence reaches the
   * target through this provider. Refusing future enrolments is the engine's
   * job, which re-checks protection at enrolment; a provider that can also
   * refuse them, does. Idempotent.
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
