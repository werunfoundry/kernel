/**
 * acquisition/runtime — pulling what comes back (decisions 0017, 0039).
 *
 * For each source bound to the `Inbound` contract, as its own run: read the
 * pages after its cursor, and for each event write
 *
 * - **the event**, once, through the core's one write path;
 * - **an inbound touch**, when the event names a person already recorded and
 *   a channel a domain declares — the person-level trace the reactive lane
 *   needs (0027). Nobody is created from an event;
 * - **the opt-out**, for `acquisition.unsubscribe`: an opt-out read and not applied
 *   would be a contact with someone who asked to stop. Once the pages are
 *   stored, every enrolment still running for someone who opted out is
 *   suspended at its sequencer (0051), outside any page's transaction; one
 *   that cannot be stops the source's run, and the next pull tries again.
 *
 * **One writer per source.** The source's cursor row is locked for the whole
 * read, and advanced in the transaction that stores the page it covers: a
 * crash replays a page, stored once, and never skips one.
 *
 * **An event that fails its check stops the source**, cursor unmoved, and the
 * run says which: skipping it would lose it for good, and it may be an
 * opt-out. A read that could not reach the source stops it the same way.
 *
 * A dry run reads the first page after the cursor, checks it and reports
 * what would be stored. It writes nothing — not the cursor either.
 */

import { eq, sql } from "drizzle-orm";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { IdentityVocabulary } from "@werunfoundry/core/identity";
import { recordEvent } from "@werunfoundry/core/runtime/event";
import type { Registry } from "@werunfoundry/core/runtime/resolve";
import type { ActorKind, Database } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";
import { findPerson, recordOptOut, recordTouch } from "@werunfoundry/relations/runtime/record";

import type { Inbound, InboundEvent } from "../contracts/inbound.js";
import { checkInboundEvent } from "../contracts/inbound.js";
import { inboundCursor } from "../db/schema.js";
import { suspendOptedOut } from "./suspend.js";

export const INBOUND = "inbound";

export interface PullDeps {
  db: Database;
  registry: Registry;
  identity: IdentityVocabulary;
  /** Every event type and channel the enabled domains declare. */
  declared: { eventTypes: ReadonlySet<string>; channels: ReadonlySet<string> };
}

export interface PullRequest {
  dryRun: boolean;
  actor: { type: ActorKind; id?: string };
  trigger: "cli" | "cron" | "manual";
  /** Asked of the source per page; the source may return fewer. */
  pageSize?: number;
  /** Pages read per source in one pull, at most. No default: the caller says how far one pull goes. */
  maxPages: number;
}

export interface SourceReport {
  provider: string;
  runId: string;
  pages: number;
  read: number;
  recorded: number;
  /** Already stored: a replayed page, or an event the source gave twice. */
  replayed: number;
  touches: number;
  optOuts: number;
  /** Events about someone the engine never recorded: stored, not tied to a person. */
  unknownPeople: number;
  /**
   * The enrolments of people who opted out, stopped at their provider after
   * the pages were stored (0051): suspended, found already gone, or — on a
   * dry run — that would be suspended.
   */
  stopped: { suspended: number; notHeld: number; would: number };
  cursor: string | null;
  stoppedBy?: string;
}

class Stop extends Error {}

const DEFAULT_PAGE = 100;

export async function pullInbound(deps: PullDeps, request: PullRequest): Promise<SourceReport[]> {
  if (!Number.isInteger(request.maxPages) || request.maxPages < 1) throw new Error("maxPages is required: how many pages one pull reads, at least one");
  const bound = deps.registry.list().filter((r) => r.contract === INBOUND);
  const providers = bound.map((r) => r.provider);
  const twice = providers.filter((p, i) => providers.indexOf(p) !== i);
  if (twice.length > 0) throw new Error(`inbound is bound twice under the name "${twice[0]}": a source is its name, and two sources cannot share a cursor`);

  const reports: SourceReport[] = [];
  for (const binding of bound) reports.push(await pullSource(deps, request, binding.provider, binding.adapter as Inbound));
  return reports;
}

async function pullSource(deps: PullDeps, request: PullRequest, provider: string, source: Inbound): Promise<SourceReport> {
  const { db } = deps;
  const open = await openRun(db, { processKey: `acquisition.inbound.${provider}`, trigger: request.trigger, actor: request.actor, dryRun: request.dryRun });
  const ctx: CallContext = open.context;
  const report: SourceReport = { provider, runId: open.id, pages: 0, read: 0, recorded: 0, replayed: 0, touches: 0, optOuts: 0, unknownPeople: 0, stopped: { suspended: 0, notHeld: 0, would: 0 }, cursor: null };

  const check = (e: InboundEvent) => {
    const issues = checkInboundEvent(e, { eventTypes: deps.declared.eventTypes, identity: deps.identity });
    if (!source.eventTypes.includes(e.type)) issues.push({ severity: "error", at: "type", message: `the source does not say it produces "${e.type}"` });
    if (issues.length > 0) throw new Stop(`event ${e.providerEventId || "(no id)"} refused, the cursor left before it: ${issues.map((i) => `${i.at}: ${i.message}`).join("; ")}`);
  };

  try {
    if (request.dryRun) {
      const [row] = await db.select({ cursor: inboundCursor.cursor }).from(inboundCursor).where(eq(inboundCursor.provider, provider));
      report.cursor = row?.cursor ?? null;
      const page = await source.events({ ...(report.cursor ? { after: report.cursor } : {}), limit: request.pageSize ?? DEFAULT_PAGE }, ctx);
      if (!page.ok) throw new Stop(`the source could not be read: ${page.error.code}: ${page.error.message}`);
      report.pages = 1;
      report.read = page.value.items.length;
      for (const e of page.value.items) check(e);
    } else {
      for (let n = 0; n < request.maxPages; n++) {
        const more = await db.transaction(async (tx) => {
          // The lock is the one writer: a second pull of this source waits here.
          await tx.insert(inboundCursor).values({ provider }).onConflictDoNothing();
          const [row] = await tx.select({ cursor: inboundCursor.cursor }).from(inboundCursor).where(eq(inboundCursor.provider, provider)).for("update");
          const after = row?.cursor ?? undefined;
          const page = await source.events({ ...(after ? { after } : {}), limit: request.pageSize ?? DEFAULT_PAGE }, ctx);
          if (!page.ok) throw new Stop(`the source could not be read: ${page.error.code}: ${page.error.message}`);
          for (const e of page.value.items) check(e);

          for (const e of page.value.items) {
            const occurredAt = new Date(e.occurredAt);
            const stored = await recordEvent(
              tx,
              { kind: e.type, provider, providerEventId: e.providerEventId, occurredAt, payload: { ...e }, runId: open.id },
              deps.declared.eventTypes,
            );
            if (!stored.recorded) {
              report.replayed++;
              continue;
            }
            report.recorded++;
            const found = e.subject.subject === "person" ? await findPerson(tx, e.subject) : { none: true as const };
            if (!("id" in found)) {
              report.unknownPeople++;
              continue;
            }
            const channel = e.attribution?.channel;
            if (channel && deps.declared.channels.has(channel)) {
              const t = await recordTouch(tx, {
                personId: found.id,
                channel,
                direction: "inbound",
                provider,
                providerEventId: e.providerEventId,
                occurredAt,
                outcome: e.type,
                actor: { type: "system" },
                runId: open.id,
              });
              if (t.recorded) report.touches++;
            }
            if (e.type === "acquisition.unsubscribe" && (await recordOptOut(tx, found.id, occurredAt)).recorded) report.optOuts++;
          }

          report.pages++;
          report.read += page.value.items.length;
          const moved = page.value.cursor !== after;
          await tx
            .update(inboundCursor)
            .set({ cursor: page.value.cursor, runId: open.id, updatedAt: sql`now()` })
            .where(eq(inboundCursor.provider, provider));
          report.cursor = page.value.cursor;
          return page.value.items.length > 0 && moved;
        });
        if (!more) break;
      }
    }
    // The opt-outs, applied at the provider once stored — never inside a
    // page's transaction, which a provider call cannot be rolled back with.
    const stopped = await suspendOptedOut({ db, registry: deps.registry }, ctx);
    report.stopped = { suspended: stopped.suspended, notHeld: stopped.notHeld, would: stopped.would };
    if (stopped.refused.length > 0) {
      throw new Stop(`people who opted out could not be stopped at their provider; the next pull tries again: ${stopped.refused.join("; ")}`);
    }
    await open.finish({ status: "succeeded" });
  } catch (thrown) {
    if (!(thrown instanceof Stop)) {
      await open.finish({ status: "failed", error: (thrown as Error).message.slice(0, 500) }).catch(() => {});
      throw thrown;
    }
    report.stoppedBy = thrown.message;
    await open.finish({ status: report.pages > 0 ? "partial" : "failed", error: thrown.message.slice(0, 500) }).catch(() => {});
  }
  return report;
}
