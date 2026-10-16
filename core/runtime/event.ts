/**
 * core/runtime — the one write path of `core.event` (decision 0039).
 *
 * An event is what was observed, appended once. Its type must be one an
 * enabled domain declares: the caller passes the declared set, because the
 * core reads no manifest of its own here and names no domain. Read twice, it
 * is stored once — the key is in the DDL, and a replay answers
 * `recorded: false`.
 */

import type { Database } from "./run.js";
import { event } from "../db/schema.js";

export interface EventInput {
  kind: string;
  provider: string;
  providerEventId: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  /** The run that read it. */
  runId: string;
}

export async function recordEvent(
  db: Database,
  input: EventInput,
  declared: ReadonlySet<string>,
): Promise<{ recorded: boolean; id?: string }> {
  if (!declared.has(input.kind)) throw new Error(`no enabled domain declares the event type "${input.kind}"`);
  if (input.providerEventId.trim() === "") throw new Error("an event without its source's id cannot be stored once");
  if (Number.isNaN(input.occurredAt.getTime())) throw new Error("an event's time is not a time");
  const inserted = await db
    .insert(event)
    .values({
      kind: input.kind,
      provider: input.provider,
      providerEventId: input.providerEventId,
      occurredAt: input.occurredAt,
      payload: input.payload,
      runId: input.runId,
    })
    .onConflictDoNothing({ target: [event.provider, event.providerEventId] })
    .returning({ id: event.id });
  return inserted[0] ? { recorded: true, id: inserted[0].id } : { recorded: false };
}
