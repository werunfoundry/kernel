/**
 * gtm/contracts — the outreach tool.
 *
 * The engine owns the copy, the variant and the decision to send; the
 * sequencer owns delivery, timing and the mailbox. Nothing here lets a caller
 * author a sequence or edit a step: a message that exists only in the provider
 * is a message no experiment can attribute, and doctrine 1 puts what is being
 * tried in the core.
 *
 * `suppress` is as important as `enrol`, and is the reason this contract exists
 * at all rather than a fire-and-forget send. An account can become protected
 * after enrolment (decision 0004); without a way to stop every running
 * sequence reaching it, protection is a promise that holds only until the
 * next step fires. `withdraw` is the narrower, ordinary act — this person,
 * out of this sequence — and the two were one method until the first real
 * provider showed they are different operations (decision 0011).
 *
 * A single message is a one-step sequence. There is no `send` here, so that
 * there is one path and one place where suppression is checked.
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";

/** The mailbox or profile a touch leaves from. Capacity is per sender. */
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
   * Who it must leave from. Optional, because some providers choose the
   * sender themselves, rotating across a pool the sequence owns. An adapter
   * that cannot honour an explicit sender refuses the enrolment as `invalid`
   * rather than accepting it and sending from someone else.
   */
  sender?: SenderRef;
  person: { email?: string; externalId?: string; fullName?: string };
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
  sender?: SenderRef;
  /** Which step the person is on, when the provider exposes it. */
  stepIndex?: number;
  /** When the provider last changed this. */
  asOf: string;
}

/** What a sender has left today, so a plan can be sized before it is run. */
export interface SenderCapacity {
  sender: SenderRef;
  dailyLimit?: number;
  usedToday?: number;
  remainingToday?: number;
  asOf: string;
}

export interface Sequencer extends Contract {
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
      person: { email?: string; externalId?: string };
      sequenceKey: string;
      /** For the audit trail. Never interpreted by the provider. */
      reason: string;
    },
    ctx: CallContext,
  ): Promise<CallResult<void>>;

  /**
   * Stop this provider reaching a person or a whole account — every running
   * sequence, at once — and keep it stopped. What protection needs after
   * enrolment (decision 0004), and why it takes a domain: what becomes
   * protected is an account, and a person-by-person withdrawal misses the
   * colleague nobody enrolled yet.
   *
   * On success, no further step of an already running sequence reaches the
   * target through this provider. Refusing future enrolments is the engine's
   * job, which re-checks protection at enrolment; a provider that can also
   * refuse them, does. Idempotent.
   */
  suppress(
    request: {
      idempotencyKey: string;
      target: { email: string } | { domain: string };
      /** For the audit trail. Never interpreted by the provider. */
      reason: string;
    },
    ctx: CallContext,
  ): Promise<CallResult<void>>;

  /**
   * One enrolment: this person, in this sequence. A person can be in several
   * sequences at once, and a status for "the person" would have to pick one.
   * A read that finds no enrolment returns `state: "unknown"`, not an error.
   */
  status(
    request: { person: { email?: string; externalId?: string }; sequenceKey: string },
    ctx: CallContext,
  ): Promise<CallResult<EnrolmentStatus>>;

  capacity(
    sender: SenderRef,
    ctx: CallContext,
  ): Promise<CallResult<SenderCapacity>>;
}
