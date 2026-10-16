/**
 * gtm/runtime — a draft, and the approval its lane requires (decision 0027).
 *
 * The draft is the review loop's source of truth: a proposed message is a
 * row here before anyone sees it, every judgement on it is a column of that
 * row, and only an approved row is let out. This file is the operator's gate;
 * it does not write copy. The schema holds the same gate underneath (the
 * trigger in migration `draft_moves_forward`), so nothing that writes the
 * table directly can skip it.
 *
 * What each lane requires before a draft may be queued:
 *
 * - **reviewed** — a human approval, always.
 * - **autonomous** — a human approval until the experiment has earned
 *   autonomy: `autonomyAfter` consecutive human approvals with no edit, a
 *   number the caller must give, because there is no default at which an
 *   agent's work is good enough. Earned, a new draft is approved by the lane.
 *   An edit or a drop sets the streak back to zero (core/runtime/experiment).
 * - **reactive** — without a human only in reply to the person's own act: an
 *   inbound touch from them, on the draft's channel — its template's — inside
 *   a window the caller gives, with no default (decision 0042). No window, no
 *   template, or no such touch, and a human approves, as on `reviewed`.
 *
 * Whatever the lane, a person who opted out is never queued, and a draft is
 * queued only while its experiment is running.
 */

import { and, eq } from "drizzle-orm";

import { laneOf, recordReview } from "@werunfoundry/core/runtime/experiment";
import { experiment } from "@werunfoundry/core/db/schema";
import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";
import { person } from "@werunfoundry/relations/db/schema";
import { engagedSince } from "@werunfoundry/relations/runtime/record";

import { draft, template } from "../db/schema.js";

export type Draft = typeof draft.$inferSelect;

export interface DraftInput {
  experimentId: string;
  personId: string;
  step: number;
  templateId?: string;
  renderedSubject?: string;
  renderedBody: string;
  sender?: string;
}

export interface Attribution {
  actor: { type: ActorKind; id?: string };
  runId?: string;
}

export interface Gate {
  /** Consecutive clean human approvals after which an autonomous lane approves on its own. */
  autonomyAfter: number;
  /**
   * How recent the person's inbound touch must be, in minutes, for a reactive
   * lane to approve a reply on its own (0042). No default: without it, a
   * human approves.
   */
  reactiveWithinMinutes?: number;
}

export type Proposed =
  | { ok: true; draft: Draft; outcome: "awaiting_review" | "approved_by_lane" | "kept" }
  | { ok: false; refused: string };

export type Decided = { ok: true; draft: Draft; autonomyStreak?: number } | { ok: false; refused: string };

const DECIDED_BY_LANE = "lane:autonomous";
const DECIDED_BY_REACTION = "lane:reactive";
const UNDECIDED = new Set(["drafting", "awaiting_review"]);

const attributed = (a: Attribution) => ({
  actorType: a.actor.type,
  actorId: a.actor.id ?? null,
  ...(a.runId ? { runId: a.runId } : {}),
});

/**
 * The reactive lane's license (0042): an inbound touch from the person, on
 * the channel of the draft's template, inside the caller's window. Without a
 * window or a template there is nothing to check against, and no license.
 */
async function reactiveLicense(db: Database, input: DraftInput, gate: Gate, now: Date): Promise<boolean> {
  if (gate.reactiveWithinMinutes === undefined || !input.templateId) return false;
  const [t] = await db.select({ channel: template.channel }).from(template).where(eq(template.id, input.templateId));
  if (!t) return false;
  return engagedSince(db, input.personId, t.channel, new Date(now.getTime() - gate.reactiveWithinMinutes * 60_000));
}

async function optedOut(db: Database, personId: string): Promise<boolean | undefined> {
  const [row] = await db.select({ optedOutAt: person.optedOutAt }).from(person).where(eq(person.id, personId));
  return row ? row.optedOutAt !== null : undefined;
}

async function locked(db: Database, id: string): Promise<Draft | undefined> {
  const [row] = await db.select().from(draft).where(eq(draft.id, id)).for("update");
  return row;
}

/**
 * Proposes a draft, and applies its lane: awaiting review, or approved by the
 * lane when the lane is autonomous and has earned it.
 *
 * Proposing the same person, step and experiment again is a regeneration: an
 * undecided draft takes the new text and keeps its state; a decided one is
 * kept as it is, and says so — regenerating a batch never reopens a decision.
 */
export async function propose(db: Database, input: DraftInput, by: Attribution, gate: Gate): Promise<Proposed> {
  if (!Number.isInteger(gate.autonomyAfter) || gate.autonomyAfter < 1) {
    throw new Error("autonomyAfter must be a whole number of approvals, at least 1");
  }
  if (gate.reactiveWithinMinutes !== undefined && !(Number.isFinite(gate.reactiveWithinMinutes) && gate.reactiveWithinMinutes > 0)) {
    throw new Error("reactiveWithinMinutes, when given, is a number of minutes above zero");
  }
  return db.transaction(async (tx) => {
    const lane = await laneOf(tx, input.experimentId);
    if (!lane) return { ok: false, refused: "no such experiment" };
    const out = await optedOut(tx, input.personId);
    if (out === undefined) return { ok: false, refused: "no such person" };
    if (out) return { ok: false, refused: "the person opted out; nothing is drafted for them" };

    const [existing] = await tx
      .select()
      .from(draft)
      .where(and(eq(draft.experimentId, input.experimentId), eq(draft.personId, input.personId), eq(draft.step, input.step)))
      .for("update");
    if (existing && !UNDECIDED.has(existing.state)) return { ok: true, draft: existing, outcome: "kept" };

    // New, or undecided and regenerated: the lane is applied to the text as it now is.
    const now = new Date();
    const decidedByLane =
      lane.lane === "autonomous" && lane.autonomyStreak >= gate.autonomyAfter
        ? DECIDED_BY_LANE
        : lane.lane === "reactive" && (await reactiveLicense(tx, input, gate, now))
          ? DECIDED_BY_REACTION
          : undefined;
    const earned = decidedByLane !== undefined;
    if (existing) {
      const [updated] = await tx
        .update(draft)
        .set({
          renderedSubject: input.renderedSubject ?? null,
          renderedBody: input.renderedBody,
          templateId: input.templateId ?? null,
          sender: input.sender ?? null,
          state: earned ? "approved" : "awaiting_review",
          ...(earned ? { decidedBy: decidedByLane, decidedAt: now } : {}),
          ...attributed(by),
        })
        .where(eq(draft.id, existing.id))
        .returning();
      return { ok: true, draft: updated!, outcome: earned ? "approved_by_lane" : "awaiting_review" };
    }

    const [created] = await tx
      .insert(draft)
      .values({
        experimentId: input.experimentId,
        personId: input.personId,
        step: input.step,
        ...(input.templateId ? { templateId: input.templateId } : {}),
        ...(input.renderedSubject !== undefined ? { renderedSubject: input.renderedSubject } : {}),
        renderedBody: input.renderedBody,
        ...(input.sender ? { sender: input.sender } : {}),
        state: earned ? "approved" : "awaiting_review",
        ...(earned ? { decidedBy: decidedByLane, decidedAt: now } : {}),
        ...attributed(by),
      })
      .returning();
    return { ok: true, draft: created!, outcome: earned ? "approved_by_lane" : "awaiting_review" };
  });
}

/**
 * A human approves a draft awaiting review, with the text as they want it
 * sent. A text different from the proposed one is an edit: the draft says
 * so, and the experiment's streak goes back to zero.
 */
export async function approve(
  db: Database,
  draftId: string,
  review: { by: string; renderedSubject?: string; renderedBody?: string },
  attribution: Attribution,
): Promise<Decided> {
  if (!review.by.trim()) return { ok: false, refused: "an approval says who gave it" };
  // The lane approves through `propose`; anything else that approves is a person.
  if (attribution.actor.type !== "human") return { ok: false, refused: "only a human approves a draft; an earned lane approves it when it is proposed" };
  return db.transaction(async (tx) => {
    const current = await locked(tx, draftId);
    if (!current) return { ok: false, refused: "no such draft" };
    if (current.state !== "awaiting_review") return { ok: false, refused: `a ${current.state} draft is not awaiting review` };
    await laneOf(tx, current.experimentId); // serialises reviews of one experiment

    const subject = review.renderedSubject ?? current.renderedSubject;
    const body = review.renderedBody ?? current.renderedBody;
    const edited = subject !== current.renderedSubject || body !== current.renderedBody;
    const [approved] = await tx
      .update(draft)
      .set({
        state: "approved",
        renderedSubject: subject,
        renderedBody: body,
        decidedBy: review.by,
        decidedAt: new Date(),
        editedBeforeApproval: edited,
        ...attributed(attribution),
      })
      .where(eq(draft.id, draftId))
      .returning();
    const autonomyStreak = await recordReview(tx, current.experimentId, edited ? "edited" : "clean");
    return { ok: true, draft: approved!, autonomyStreak };
  });
}

/**
 * Drops a draft before it is queued, with the reason. A human's drop is a
 * review — the work was not usable — and sets the streak back to zero; a
 * drop by the system (an opt-out) says nothing about the work and moves it
 * not at all.
 */
export async function drop(db: Database, draftId: string, decision: { by: string; reason: string }, attribution: Attribution): Promise<Decided> {
  if (!decision.by.trim()) return { ok: false, refused: "a drop says who made it" };
  if (!decision.reason.trim()) return { ok: false, refused: "a drop says why" };
  return db.transaction(async (tx) => {
    const current = await locked(tx, draftId);
    if (!current) return { ok: false, refused: "no such draft" };
    if (!["drafting", "awaiting_review", "approved"].includes(current.state)) {
      return { ok: false, refused: `a ${current.state} draft is past dropping` };
    }
    await laneOf(tx, current.experimentId);
    const [dropped] = await tx
      .update(draft)
      .set({ state: "dropped", decidedBy: decision.by, decidedAt: new Date(), dropReason: decision.reason, ...attributed(attribution) })
      .where(eq(draft.id, draftId))
      .returning();
    const autonomyStreak = attribution.actor.type === "human" ? await recordReview(tx, current.experimentId, "dropped") : undefined;
    return { ok: true, draft: dropped!, ...(autonomyStreak !== undefined ? { autonomyStreak } : {}) };
  });
}

/**
 * The gate itself: hands an approved draft to sending. Anything not approved
 * stays where it is. A person who opted out since the approval is dropped
 * here, by the system, whatever the lane; an experiment that is not running
 * sends nothing.
 */
export async function queue(db: Database, draftId: string, attribution: Attribution): Promise<Decided> {
  return db.transaction(async (tx) => {
    const current = await locked(tx, draftId);
    if (!current) return { ok: false, refused: "no such draft" };
    if (current.state !== "approved") return { ok: false, refused: `a ${current.state} draft is not sent: only an approved one is` };

    const [exp] = await tx.select({ status: experiment.status }).from(experiment).where(eq(experiment.id, current.experimentId));
    if (exp?.status !== "running") return { ok: false, refused: `the experiment is ${exp?.status ?? "gone"}, not running` };

    if ((await optedOut(tx, current.personId)) !== false) {
      await tx
        .update(draft)
        .set({ state: "dropped", decidedBy: "system", decidedAt: new Date(), dropReason: "the person opted out after the approval", ...attributed(attribution) })
        .where(eq(draft.id, draftId));
      return { ok: false, refused: "the person opted out; the draft is dropped" };
    }

    const [queued] = await tx
      .update(draft)
      .set({ state: "queued", ...attributed(attribution) })
      .where(eq(draft.id, draftId))
      .returning();
    return { ok: true, draft: queued! };
  });
}
