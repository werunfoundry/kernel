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
 * exist yet. This domain is where it waits, not where that is satisfied
 * (0047).
 *
 * Declared on a company only (0047). Being a customer is a property of a
 * person's affiliation to a company, bounded in time; that affiliation does
 * not exist, and the company is the closest subject the record has. The
 * schema still accepts a person: the refusal is here, for every caller.
 *
 * A declaration feeds no protection: protection reads its own source, never
 * this (0041).
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

/**
 * The moment a state became true, as a person types it: an ISO time with its
 * zone, or a date, read as that day at 00:00 UTC. A time without a zone is
 * refused — read in the terminal's zone, the same words would name another
 * moment elsewhere.
 */
export function readMoment(text: string): { at: Date } | { refused: string } {
  const t = text.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    return { refused: `"${t}" is neither a date (2026-09-01) nor a time with its zone (2026-09-01T09:30:00Z)` };
  }
  const at = new Date(dateOnly ? `${t}T00:00:00Z` : t);
  return Number.isNaN(at.getTime()) ? { refused: `"${t}" is not a moment` } : { at };
}

/**
 * What a declaration would do, read before anything is written (0047). The
 * same declaration as the current one writes nothing. The same state from
 * another moment is refused: a second row would only move "since when". A
 * different state is declared, and becomes current only when it is not
 * dated before the current one — otherwise it is history.
 */
export type DeclarationPlan = { already: true } | { refused: string } | { declare: true; current: boolean };

export function planDeclaration(current: { state: string; at: Date } | undefined, input: { state: string; at: Date }): DeclarationPlan {
  if (!current) return { declare: true, current: true };
  if (current.state === input.state) {
    if (current.at.getTime() === input.at.getTime()) return { already: true };
    return { refused: `it already stands as ${current.state} since ${current.at.toISOString()}; a second declaration would only move that moment` };
  }
  return { declare: true, current: input.at.getTime() >= current.at.getTime() };
}

/**
 * A person declares a company's relationship. Replaying the same one keeps
 * one row, and says so. A person is refused as a subject (0047).
 */
export async function declareRelationship(
  db: Database,
  input: { subject: { companyId: string }; status: RelationshipStatus; at: Date; reason?: string; by: string },
): Promise<{ runId: string; declared: boolean }> {
  if ("personId" in input.subject || !input.subject.companyId) {
    throw new Error("a relationship is declared on a company, not on a person alone (decision 0047)");
  }
  const refused = checkDeclaration(input);
  if (refused) throw new Error(refused);
  const by = input.by.trim();
  const open = await openRun(db, { processKey: "relations.relationship.declare", trigger: "manual", actor: { type: "human", id: by }, dryRun: false });
  try {
    const written = await db
      .insert(relationship)
      .values({
        companyId: input.subject.companyId,
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
