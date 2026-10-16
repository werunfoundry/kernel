/**
 * relations/runtime — declaring a relationship (decision 0036): that a person
 * or a company is a customer, a former customer, or neither, from a given
 * moment.
 *
 * A person declares it, each declaration in its own recorded run with the
 * person as actor, as an acknowledgement is (0034). The schema refuses any
 * other actor and any rewrite; a mistaken declaration is corrected by
 * another, which says why. Nothing here is computed: the domain that
 * observes a payment should one day write `customer` itself, and does not
 * exist yet.
 */

import { eq } from "drizzle-orm";

import type { Database } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";

import { relationship, relationshipCurrent } from "../db/schema.js";

export type RelationshipStatus = (typeof relationship.status.enumValues)[number];
export type Subject = { personId: string } | { companyId: string };

export interface Declared {
  status: RelationshipStatus;
  at: Date;
  reason: string | null;
  declaredBy: string;
}

/**
 * Refuses what the schema cannot see: a declaration with nobody behind it,
 * or one dated in the future — a state is declared once it is true.
 */
export function checkDeclaration(input: { at: Date; by: string }, now = new Date()): string | undefined {
  if (input.by.trim() === "") return "who declares is required: a declaration is a person's";
  if (Number.isNaN(input.at.getTime())) return "the moment it became true is not a time";
  if (input.at.getTime() > now.getTime()) return "a state is declared once it is true, not ahead of it";
  return undefined;
}

/** A person declares a relationship. Replaying the same one keeps one row, and says so. */
export async function declareRelationship(
  db: Database,
  input: { subject: Subject; status: RelationshipStatus; at: Date; reason?: string; by: string },
): Promise<{ runId: string; declared: boolean }> {
  const refused = checkDeclaration(input);
  if (refused) throw new Error(refused);
  const by = input.by.trim();
  const open = await openRun(db, { processKey: "relations.relationship.declare", trigger: "manual", actor: { type: "human", id: by }, dryRun: false });
  try {
    const written = await db
      .insert(relationship)
      .values({
        ...input.subject,
        status: input.status,
        at: input.at,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        actorType: "human",
        actorId: by,
        runId: open.id,
      })
      .onConflictDoNothing()
      .returning({ id: relationship.id });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, declared: written.length > 0 };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}

/** The current relationship, through the view this domain publishes; none when nobody declared one. */
export async function readRelationship(db: Database, subject: Subject): Promise<Declared | undefined> {
  const where = "personId" in subject ? eq(relationshipCurrent.personId, subject.personId) : eq(relationshipCurrent.companyId, subject.companyId);
  const [row] = await db
    .select({ status: relationshipCurrent.status, at: relationshipCurrent.at, reason: relationshipCurrent.reason, declaredBy: relationshipCurrent.actorId })
    .from(relationshipCurrent)
    .where(where);
  return row;
}
