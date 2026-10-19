/**
 * acquisition/runtime — a person constitutes a list (decisions 0037, 0047),
 * from what a sourcing run kept or from a hand selection.
 *
 * The list is `relations`' object and `constituteList` its only writer; this
 * is the selecting process. It reads where the members come from — a run's
 * result, which does not move, or a file of keys that must each name a
 * recorded subject — and never a live query: a list is frozen (0037).
 *
 * **Nothing here reads an opt-out or protection, and nobody is filtered.** A
 * list is a selection, never a permission: a list filtered when it is made
 * would read as cleared to contact. Consent and protection are evaluated when
 * something is sent.
 */

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { run as runTable } from "@werunfoundry/core/db/schema";
import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { withRun } from "@werunfoundry/core/runtime/run";
import type { ListRead, Member } from "@werunfoundry/relations/runtime/list";
import { person } from "@werunfoundry/relations/db/schema";
import { constituteList, readList } from "@werunfoundry/relations/runtime/list";
import { nameCompany, namePerson } from "@werunfoundry/relations/runtime/record";

import { sourcingResult } from "../db/schema.js";

export interface Selection {
  /** As 0037 keeps it beside the list: where the members came from. */
  query: Record<string, unknown>;
  members: Member[];
  /** One line each, for the person to read before confirming. */
  shown: string[];
}

/**
 * The people a live, finished sourcing run kept, as that run recorded them.
 * A dry run kept nobody on record, a failed or running one did not finish
 * deciding, a run of another process is not a sourcing run: each is refused
 * with its reason, as enrolment refuses them (0032).
 */
export async function selectFromRun(db: Database, runId: string): Promise<Selection> {
  const [source] = await db
    .select({ processKey: runTable.processKey, dryRun: runTable.dryRun, status: runTable.status })
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!source) throw new Error(`no run ${runId} is on record`);
  if (source.processKey !== "acquisition.source") throw new Error(`run ${runId} is a run of ${source.processKey}, not a sourcing run`);
  if (source.dryRun) throw new Error(`run ${runId} was a dry run: it kept nobody on record`);
  if (source.status !== "succeeded" && source.status !== "partial") {
    throw new Error(`run ${runId} ${source.status === "running" ? "is still running" : `ended as ${source.status}`}; only a finished sourcing run can be selected from`);
  }
  // The inner join keeps a recorded person only. Shown by the address recorded, not by the run's subject: that is a
  // digest of the keys, which no person can read.
  const rows = await db
    .select({ personId: sourcingResult.personId, email: person.email, detail: sourcingResult.detail })
    .from(sourcingResult)
    .innerJoin(person, eq(person.id, sourcingResult.personId))
    .where(and(eq(sourcingResult.runId, runId), eq(sourcingResult.outcome, "kept")));
  return {
    query: { from: "acquisition.sourcing_result", runId, outcome: "kept" },
    members: rows.map((r) => ({ personId: r.personId!, reason: r.detail })),
    shown: rows.map((r) => r.email ?? r.personId!),
  };
}

/**
 * A hand selection: one address or domain per line, blank lines and `#`
 * comments aside. Every line must name a recorded subject, or nothing is
 * selected and every line that does not is named.
 */
export async function selectFromLines(db: Database, text: string, file: string): Promise<Selection> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) throw new Error(`${file} names nobody`);
  const members: Member[] = [];
  const shown: string[] = [];
  const unknown: string[] = [];
  for (const line of lines) {
    const named = line.includes("@") ? await namePerson(db, line) : await nameCompany(db, line);
    if ("refused" in named) {
      unknown.push(`${line}: ${named.refused}`);
      continue;
    }
    members.push(line.includes("@") ? { personId: named.id } : { companyId: named.id });
    shown.push(named.label);
  }
  if (unknown.length > 0) throw new Error(`every line must name a recorded subject; these do not:\n  ${unknown.join("\n  ")}`);
  const sha256 = createHash("sha256").update(text).digest("hex");
  return { query: { from: "hand", file, sha256 }, members, shown };
}

/** The list a key already names, for a person to read before anything is written. */
export async function existingList(db: Database, key: string): Promise<ListRead | undefined> {
  return readList(db, key.trim());
}

/**
 * The list, constituted in its own run with the person as actor. A key that
 * already names a list is refused before any run is opened; one written
 * meanwhile keeps the first list, as `constituteList` does, and says so. The
 * caller says how the run was reached (decision 0048).
 */
export async function constituteSelection(
  db: Database,
  input: { key: string; description?: string; selection: Selection; by: string; trigger: Trigger },
): Promise<{ runId: string; listId: string; constituted: boolean; members: number }> {
  const key = input.key.trim();
  const by = input.by.trim();
  if (key === "") throw new Error("a list needs a key");
  if (by === "") throw new Error("who constitutes it is required: this list is a person's selection");
  if (input.selection.members.length === 0) throw new Error("the selection names nobody: an empty list is not constituted");
  const existing = await readList(db, key);
  if (existing) throw new Error(`a list ${key} already exists, constituted on ${existing.createdAt.toISOString()} by ${existing.actorId ?? "nobody named"} with ${existing.members.length} members`);
  return withRun(db, { processKey: "acquisition.list.constitute", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false }, async (context) => {
    const made = await constituteList(db, {
      key,
      ...(input.description ? { description: input.description } : {}),
      query: input.selection.query,
      members: input.selection.members,
      actor: { type: "human", id: by },
      runId: context.runId,
    });
    return { runId: context.runId, ...made };
  });
}
