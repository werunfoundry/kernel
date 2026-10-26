/**
 * acquisition/contracts — what comes back: replies, bounces, opt-outs, meetings,
 * signups (decision 0017).
 *
 * The events are the ones this domain already declares in `domain.yaml`:
 * `acquisition.reply`, `acquisition.bounce`, `acquisition.unsubscribe`, `acquisition.meeting_booked`,
 * `acquisition.signup`. An adapter says which of them it can produce.
 *
 * **Pulled, not pushed.** The engine asks for what happened after a cursor,
 * and gets the next cursor back with every page, even an empty one. The
 * kernel runs as commands — no server, no session — and a cursor can be read
 * again: an event missed is re-read, never silently gone, which is what a
 * webhook nobody received becomes. A provider that only pushes is adapted by
 * something that receives and queues, and the adapter reads the queue.
 *
 * Delivery is at least once. The same event may come twice; its
 * `providerEventId`, with the adapter's provider, is the key it is stored
 * under (`core.event` is unique on both), so twice is once.
 *
 * Three things this contract deliberately does not do:
 *
 * - **No message bodies.** A reply's text belongs to the mailbox it arrived
 *   in, and is read there when someone needs it (doctrine 3). An event says
 *   that a reply happened, to whom, and on which run.
 * - **No acknowledgement.** Reading never deletes, marks or archives
 *   anything at the provider. The cursor is the engine's bookkeeping, not the
 *   provider's.
 * - **No interpretation.** Whether a reply is interested is not decided
 *   here. A provider's own label may travel in `detail`; nothing branches on
 *   it.
 *
 * Who did it is not what it says (decision 0071). The source says whether
 * the person named did it themselves, in `byThePerson`; only then does an
 * act of theirs toward us leave an inbound touch, the reactive lane's
 * license (0042).
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type { ValidationIssue } from "@werunfoundry/core/manifest/types";
import type { Identity, IdentityVocabulary } from "@werunfoundry/core/identity";
import { checkIdentity } from "@werunfoundry/core/identity";

export interface InboundEvent {
  /** The provider's own id for this event: with the provider's name, its key. */
  providerEventId: string;
  /** One of the event types the enabled domains declare, and the adapter lists. */
  type: string;
  /** When it happened at the provider — not when it was read. */
  occurredAt: string;
  /** Who it is about (decision 0013). */
  subject: Identity;
  /**
   * What the engine carried out with the enrolment, carried back: how an
   * event is tied to the run that caused it. Absent for an event the engine
   * did not cause — a signup nobody was contacted for.
   */
  attribution?: {
    runId?: string;
    sequenceKey?: string;
    channel?: string;
    experimentSlug?: string;
    variant?: string;
  };
  /**
   * The source's word that the person in `subject` did it themselves
   * (0071): a reply they wrote, not one a machine wrote for them or someone
   * else wrote in the thread. Absent is not theirs: the event is stored and
   * writes no touch. A source that cannot tell leaves it out.
   */
  byThePerson?: boolean;
  /** Small facts about the event, never a body. Not interpreted. */
  detail?: Record<string, string | number | boolean | null>;
}

export interface InboundPage {
  /** In the order they happened. Empty means nothing new, not a failure. */
  items: InboundEvent[];
  /** Where to resume. Always present, even after an empty page. Opaque. */
  cursor: string;
}

export interface Inbound extends Contract {
  /** The event types this adapter can produce, from those the domains declare. */
  readonly eventTypes: readonly string[];

  /**
   * What happened after `after`, or from the provider's beginning without
   * one. A read that could not reach the provider is an error, never an
   * empty page: "nothing happened" and "could not ask" are different.
   */
  events(
    request: { after?: string; limit?: number },
    ctx: CallContext,
  ): Promise<CallResult<InboundPage>>;
}

/**
 * Everything wrong with an inbound event before it is stored, at once: a
 * type no enabled domain declares, a subject that is not a valid identity, a
 * time that is not one, a missing key, a run reference that cannot be one.
 */
export function checkInboundEvent(
  event: InboundEvent,
  known: { eventTypes: ReadonlySet<string>; identity: IdentityVocabulary },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (at: string, message: string) => issues.push({ severity: "error", at, message });
  if (!event.providerEventId.trim()) error("providerEventId", "empty: an event without its own id cannot be stored once");
  if (!known.eventTypes.has(event.type)) error("type", `no enabled domain declares the event type "${event.type}"`);
  if (Number.isNaN(Date.parse(event.occurredAt))) error("occurredAt", "not a time");
  for (const i of checkIdentity(event.subject, known.identity)) error(`subject.${i.at}`, i.message);
  const runId = event.attribution?.runId;
  if (runId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    error("attribution.runId", "not a run id: runs are identified by uuid");
  }
  return issues;
}
