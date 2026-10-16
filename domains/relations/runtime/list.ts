/**
 * relations/runtime — constituting and reading a list (decision 0037).
 *
 * A list is frozen at the moment it is made: the list, its members and its
 * seal are written in one transaction, and the schema refuses any change
 * after. The query that produced it is kept beside it, so the selection can
 * be replayed into a new list.
 *
 * A list is a selection, never a permission. Nothing here — and nothing that
 * reads a list — decides who may be contacted: consent, opt-out and
 * protection are read when something is sent.
 */

import { eq, sql } from "drizzle-orm";

import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";

import { list, listMember } from "../db/schema.js";

export type Member = ({ personId: string } | { companyId: string }) & { reason?: string };

export interface ListInput {
  key: string;
  description?: string;
  /** The selection as the selecting process declares it; kept as given, to replay it. */
  query: Record<string, unknown>;
  members: Member[];
  actor: { type: ActorKind; id?: string };
  /** The run that selected. Required: it is the evidence of what was targeted. */
  runId: string;
}

/**
 * Makes a list and seals it, in one transaction. A key that already names a
 * list changes nothing — the first list stands, as the evidence it is — and
 * the answer says so.
 */
export async function constituteList(db: Database, input: ListInput): Promise<{ listId: string; constituted: boolean; members: number }> {
  const key = input.key.trim();
  if (key === "") throw new Error("a list needs a key");
  return db.transaction(async (tx) => {
    const [made] = await tx
      .insert(list)
      .values({
        key,
        ...(input.description ? { description: input.description } : {}),
        query: input.query,
        actorType: input.actor.type,
        ...(input.actor.id ? { actorId: input.actor.id } : {}),
        runId: input.runId,
      })
      .onConflictDoNothing({ target: list.key })
      .returning({ id: list.id });
    if (!made) {
      const [existing] = await tx.select({ id: list.id }).from(list).where(eq(list.key, key));
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(listMember).where(eq(listMember.listId, existing!.id));
      return { listId: existing!.id, constituted: false, members: count?.n ?? 0 };
    }
    let members = 0;
    if (input.members.length > 0) {
      const written = await tx
        .insert(listMember)
        .values(input.members.map((m) => ({ listId: made.id, ...m })))
        .onConflictDoNothing()
        .returning({ id: listMember.id });
      members = written.length;
    }
    await tx.update(list).set({ sealedAt: new Date() }).where(eq(list.id, made.id));
    return { listId: made.id, constituted: true, members };
  }) as Promise<{ listId: string; constituted: boolean; members: number }>;
}

export interface ListRead {
  key: string;
  query: unknown;
  sealedAt: Date | null;
  members: { personId: string | null; companyId: string | null; reason: string | null }[];
}

/** A list as it was constituted: its query and its members. Reads only. */
export async function readList(db: Database, key: string): Promise<ListRead | undefined> {
  const [row] = await db.select({ id: list.id, key: list.key, query: list.query, sealedAt: list.sealedAt }).from(list).where(eq(list.key, key));
  if (!row) return undefined;
  const members = await db
    .select({ personId: listMember.personId, companyId: listMember.companyId, reason: listMember.reason })
    .from(listMember)
    .where(eq(listMember.listId, row.id));
  return { key: row.key, query: row.query, sealedAt: row.sealedAt, members };
}
