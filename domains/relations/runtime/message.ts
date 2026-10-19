/**
 * relations/runtime — writing a message, and the gate it passes (decision
 * 0038).
 *
 * A message is what is sent to a person, written as it is handed over to be
 * sent. Writing it asks whether sending is lawful — a question apart from
 * the draft's, which asks whether the content is approved (0027). The two
 * add up: a domain that makes no draft still comes through here, and a draft
 * its lane approved still does when its message is written.
 *
 * Refused, all at once, and nothing written:
 *
 * - **consent** — the person opted out. The opt-out is global today, so it
 *   refuses every message, solicited or not, until consent is per purpose;
 * - **cadence** — an unsolicited message with no cap given (there is no
 *   default), or past it. The cap reads touches (decision 0050): the
 *   unsolicited outbound touches to the person inside the cap's window,
 *   whoever recorded them, plus the unsolicited messages inside it that no
 *   touch names yet — handed over and not confirmed, which count rather than
 *   let a second through. A message and its touch count once. A solicited
 *   message is never held back by a cadence;
 * - **lane** — a message whose writer is not a person and which names no
 *   approval; or the lane's approval where the lane does not give it:
 *   `lane:autonomous` only for an experiment whose lane is autonomous and
 *   which is running; `lane:reactive` only for a running reactive
 *   experiment, and when the person reached us on this channel inside the
 *   caller's window — an inbound touch, the same license the draft's gate
 *   reads (0042).
 *
 * Protection is not part of it: it is a rule of the addressing motion, and an
 * answer to a customer's question must not be refused by it.
 */

import { and, eq, gt, notExists, sql } from "drizzle-orm";

import { experiment } from "@werunfoundry/core/db/schema";
import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";

import { message, person, touch } from "../db/schema.js";
import { engagedSince } from "./record.js";

export interface MessageInput {
  /** The writer's key for this send. Writing it again is the same message. */
  key: string;
  personId: string;
  channel: string;
  sender?: string;
  subject?: string;
  body: string;
  /** Whether the person did not ask for it. No default. */
  unsolicited: boolean;
  /** Required when unsolicited: at most `max` unsolicited messages to the person in `withinDays`. */
  cap?: { max: number; withinDays: number };
  experimentId?: string;
  /** A person's name, `lane:autonomous` or `lane:reactive`. Required when the writer is not a person. */
  approvedBy?: string;
  /** For `lane:reactive`: how recent the person's inbound touch must be, in minutes. No default. */
  reactiveWithinMinutes?: number;
  actor: { type: ActorKind; id?: string };
  runId?: string;
}

export type Written = { ok: true; messageId: string; written: boolean } | { ok: false; refused: string[] };

const DAY = 86_400_000;

export async function writeMessage(db: Database, input: MessageInput, now = new Date()): Promise<Written> {
  return db.transaction(async (tx) => {
    const [already] = await tx.select({ id: message.id }).from(message).where(eq(message.key, input.key));
    if (already) return { ok: true, messageId: already.id, written: false };

    const refused: string[] = [];

    // Locked, so two writes to one person count the cap one after the other.
    const [who] = await tx.select({ optedOutAt: person.optedOutAt }).from(person).where(eq(person.id, input.personId)).for("update");
    if (!who) return { ok: false, refused: ["the person is not recorded"] };
    if (who.optedOutAt !== null) refused.push("consent: the person opted out");

    if (input.unsolicited) {
      const cap = input.cap;
      if (!cap || !Number.isInteger(cap.max) || cap.max < 0 || !(cap.withinDays > 0)) {
        refused.push("cadence: an unsolicited message needs a cap — a count and a window — and there is no default");
      } else {
        const since = new Date(now.getTime() - cap.withinDays * DAY);
        // Served by the touch index on (person, occurred_at).
        const [touches] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(touch)
          .where(and(eq(touch.personId, input.personId), eq(touch.direction, "outbound"), eq(touch.unsolicited, true), gt(touch.occurredAt, since)));
        // Served by the message index on unsolicited (person, written_at), and the touch's unique message.
        const [unconfirmed] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(message)
          .where(
            and(
              eq(message.personId, input.personId),
              eq(message.unsolicited, true),
              gt(message.writtenAt, since),
              notExists(tx.select({ id: touch.id }).from(touch).where(eq(touch.messageId, message.id))),
            ),
          );
        const n = (touches?.n ?? 0) + (unconfirmed?.n ?? 0);
        if (n >= cap.max) refused.push(`cadence: ${n} unsolicited contacts with this person in ${cap.withinDays} days, at a cap of ${cap.max}`);
      }
    }

    const approval = input.approvedBy?.trim() || undefined;
    if (input.actor.type !== "human") {
      if (!approval) refused.push("lane: a message not written by a person names who approved it");
      else if (approval === "lane:reactive") {
        const within = input.reactiveWithinMinutes;
        if (!input.experimentId) refused.push("lane: a reactive approval needs the experiment whose lane gives it");
        else if (within === undefined || !(within > 0)) refused.push("lane: a reactive approval needs a window, in minutes, and there is no default");
        else {
          const [e] = await tx.select({ lane: experiment.lane, status: experiment.status }).from(experiment).where(eq(experiment.id, input.experimentId));
          if (!e) refused.push("lane: the experiment is not recorded");
          else {
            if (e.lane !== "reactive") refused.push(`lane: the experiment's lane is ${e.lane}, not reactive`);
            if (e.status !== "running") refused.push(`lane: the experiment is ${e.status}, not running`);
          }
          if (!(await engagedSince(tx, input.personId, input.channel, new Date(now.getTime() - within * 60_000)))) {
            refused.push(`lane: the person has not reached us on ${input.channel} in the last ${within} minutes`);
          }
        }
      } else if (approval === "lane:autonomous") {
        if (!input.experimentId) refused.push("lane: an autonomous approval needs the experiment whose lane gives it");
        else {
          const [e] = await tx.select({ lane: experiment.lane, status: experiment.status }).from(experiment).where(eq(experiment.id, input.experimentId));
          if (!e) refused.push("lane: the experiment is not recorded");
          else {
            if (e.lane !== "autonomous") refused.push(`lane: the experiment's lane is ${e.lane}, not autonomous`);
            if (e.status !== "running") refused.push(`lane: the experiment is ${e.status}, not running`);
          }
        }
      } else if (approval.startsWith("lane:")) refused.push(`lane: ${approval} is not a lane that approves`);
    }

    if (refused.length > 0) return { ok: false, refused };

    const [written] = await tx
      .insert(message)
      .values({
        key: input.key,
        personId: input.personId,
        channel: input.channel,
        ...(input.sender ? { sender: input.sender } : {}),
        ...(input.subject ? { subject: input.subject } : {}),
        body: input.body,
        unsolicited: input.unsolicited,
        ...(input.experimentId ? { experimentId: input.experimentId } : {}),
        ...(approval ? { approvedBy: approval } : {}),
        actorType: input.actor.type,
        ...(input.actor.id ? { actorId: input.actor.id } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        writtenAt: now,
      })
      .returning({ id: message.id });
    return { ok: true, messageId: written!.id, written: true };
  }) as Promise<Written>;
}
