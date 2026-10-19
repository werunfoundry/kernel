/**
 * acquisition/runtime — declaring a stage of the addressing motion (decision 0036):
 * targeted, engaged, opportunity.
 *
 * A person declares it, from the moment it became true, each declaration in
 * its own recorded run with the person as actor. Nothing here infers a stage
 * from a reply or a meeting: that would be a run declaring, and the schema
 * refuses it. The history is kept — a stage is corrected by another
 * declaration — and the current stage is read through the view this domain
 * publishes, which is where another domain reads it too.
 *
 * Being a customer is not a stage: it is `relations.relationship`.
 */

import { eq } from "drizzle-orm";

import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { checkDeclaration } from "@werunfoundry/relations/runtime/relationship";

import { companyState, companyStateCurrent, personState, personStateCurrent } from "../db/schema.js";

export type Stage = (typeof personState.stage.enumValues)[number];
export type Subject = { personId: string } | { companyId: string };

export interface DeclaredStage {
  stage: Stage;
  at: Date;
  reason: string | null;
  declaredBy: string;
}

/**
 * A person declares a stage. Replaying the same one keeps one row, and says so.
 * The caller says how the run was reached — its channel; who acts is the actor
 * (decision 0048).
 */
export async function declareStage(
  db: Database,
  input: { subject: Subject; stage: Stage; at: Date; reason?: string; by: string; trigger: Trigger },
): Promise<{ runId: string; declared: boolean }> {
  const refused = checkDeclaration(input);
  if (refused) throw new Error(refused);
  const by = input.by.trim();
  const open = await openRun(db, { processKey: "acquisition.stage.declare", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const common = {
      stage: input.stage,
      at: input.at,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      actorType: "human" as const,
      actorId: by,
      runId: open.id,
    };
    const written =
      "personId" in input.subject
        ? await db.insert(personState).values({ personId: input.subject.personId, ...common }).onConflictDoNothing().returning({ id: personState.id })
        : await db.insert(companyState).values({ companyId: input.subject.companyId, ...common }).onConflictDoNothing().returning({ id: companyState.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, declared: written.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** The current stage, through the published view; none when nobody declared one. */
export async function readStage(db: Database, subject: Subject): Promise<DeclaredStage | undefined> {
  if ("personId" in subject) {
    const [row] = await db
      .select({ stage: personStateCurrent.stage, at: personStateCurrent.at, reason: personStateCurrent.reason, declaredBy: personStateCurrent.actorId })
      .from(personStateCurrent)
      .where(eq(personStateCurrent.personId, subject.personId));
    return row;
  }
  const [row] = await db
    .select({ stage: companyStateCurrent.stage, at: companyStateCurrent.at, reason: companyStateCurrent.reason, declaredBy: companyStateCurrent.actorId })
    .from(companyStateCurrent)
    .where(eq(companyStateCurrent.companyId, subject.companyId));
  return row;
}
