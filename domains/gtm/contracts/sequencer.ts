/**
 * gtm/contracts — the outreach tool.
 *
 * The engine owns the copy, the variant and the decision to send; the
 * sequencer owns delivery, timing and the mailbox. Nothing here lets a caller
 * author a sequence or edit a step: a message that exists only in the provider
 * is a message no experiment can attribute, and doctrine 1 puts what is being
 * tried in the core.
 *
 * `withdraw` is as important as `enrol`, and is the reason this contract exists at
 * all rather than a fire-and-forget send. An account can become protected
 * after enrolment; without a way to pull a person out of a running sequence,
 * protection is a promise that holds only until the next step fires.
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
  /** Supplied by the caller: the caller knows what "the same" means. */
  idempotencyKey: string;
  /** The sequence as the instance declared it, not as the provider names it. */
  sequenceKey: string;
  sender: SenderRef;
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
   * Remove a person from every running sequence, or from one named sequence.
   * Idempotent: withdrawing someone who is not enrolled succeeds.
   */
  withdraw(
    request: {
      idempotencyKey: string;
      person: { email?: string; externalId?: string };
      sequenceKey?: string;
      /** For the audit trail. Never interpreted by the provider. */
      reason: string;
    },
    ctx: CallContext,
  ): Promise<CallResult<void>>;

  /** A read that finds no enrolment returns `state: "unknown"`, not an error. */
  status(
    person: { email?: string; externalId?: string },
    ctx: CallContext,
  ): Promise<CallResult<EnrolmentStatus>>;

  capacity(
    sender: SenderRef,
    ctx: CallContext,
  ): Promise<CallResult<SenderCapacity>>;
}
