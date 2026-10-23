/**
 * acquisition/runtime — a person approves a draft at a terminal (decisions
 * 0027, 0047): what `kernel-approve` reads, and the run each approval is.
 *
 * 0027 says only a human approves, and `approve` refuses an actor that is not
 * one; but it cannot tell a person from code that says it is one. Called from
 * a script, it writes "a person approved" over an approval nobody gave. The
 * command can tell: it refuses without a terminal and asks for the address
 * the draft goes to to be typed again, one draft at a time. Each approval is
 * a run of its own, with the person as its actor.
 */

import { and, asc, eq } from "drizzle-orm";

import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { person } from "@werunfoundry/relations/db/schema";

import { draft, template } from "../db/schema.js";
import type { Decided } from "./draft.js";
import { approve } from "./draft.js";

/** A draft awaiting review, as a person reads it before approving it. */
export interface AwaitingDraft {
  id: string;
  step: number;
  /** The template's channel; none when the template is gone. */
  channel?: string;
  subject: string | null;
  body: string | null;
  /** What the person types again: the address the draft goes to, or the person's id on a network. None for a person whose keys were erased. */
  label?: string;
  fullName?: string;
  createdAt: Date;
}

/**
 * The drafts of an experiment awaiting review, oldest first. Served by
 * `draft_state_created_at_idx`, the experiment filtered after: one
 * experiment's review is a small part of what awaits.
 */
export async function awaitingReview(db: Database, experimentId: string): Promise<AwaitingDraft[]> {
  const rows = await db
    .select({
      id: draft.id,
      step: draft.step,
      channel: template.channel,
      subject: draft.renderedSubject,
      body: draft.renderedBody,
      email: person.email,
      externalId: person.externalId,
      fullName: person.fullName,
      createdAt: draft.createdAt,
    })
    .from(draft)
    .innerJoin(person, eq(person.id, draft.personId))
    .leftJoin(template, eq(template.id, draft.templateId))
    .where(and(eq(draft.state, "awaiting_review"), eq(draft.experimentId, experimentId)))
    .orderBy(asc(draft.createdAt), asc(draft.step));
  return rows.map((r) => ({
    id: r.id,
    step: r.step,
    ...(r.channel ? { channel: r.channel } : {}),
    subject: r.subject,
    body: r.body,
    ...((r.email ?? r.externalId) ? { label: (r.email ?? r.externalId)! } : {}),
    ...(r.fullName ? { fullName: r.fullName } : {}),
    createdAt: r.createdAt,
  }));
}

/** One approval, as a run of its own with the person as its actor. A refusal fails the run with its reason. */
export async function approveAsPerson(db: Database, input: { draftId: string; by: string; trigger: Trigger }): Promise<{ runId: string; decided: Decided }> {
  const by = input.by.trim();
  const open = await openRun(db, { processKey: "acquisition.draft.approve", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const decided = await approve(db, input.draftId, { by }, { actor: { type: "human", id: by }, runId: open.id });
    await open.finish(decided.ok ? { status: "succeeded" } : { status: "failed", error: decided.refused.slice(0, 500) });
    return { runId: open.id, decided };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
