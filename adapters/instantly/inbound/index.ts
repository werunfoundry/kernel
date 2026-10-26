/**
 * adapters/instantly/inbound — the acquisition `Inbound` contract, against
 * the sequencer's mailbox: the replies Instantly receives to the campaigns
 * the instance binds (decision 0071).
 *
 *   - contract: inbound
 *     adapter: "@werunfoundry/adapters/instantly/inbound"
 *     env: [INSTANTLY_API_KEY]
 *     options:
 *       campaign.<sequenceKey>: <Instantly campaign id>   # as on the sequencer binding
 *
 * It produces one event type, `acquisition.reply`, one per reply received in
 * a bound campaign. Read in the provider's published API document, not
 * observed on a live reply unless the README says so:
 *
 * - **`GET /api/v2/emails`, `email_type=received`**, oldest first by when
 *   the provider recorded it (`timestamp_created`), `preview_only` so that
 *   as little of a body as the API allows is sent. No body is read: the
 *   event says a reply happened, to whom, and on which sequence.
 * - **The subject is the lead** the provider ties the reply to (`lead`). On
 *   2026-10-22 it tied to the lead a reply written from another address in
 *   the thread (README).
 * - **`byThePerson`** (0071) is true only when the provider marks the reply
 *   not automatic (`is_auto_reply` 0, not merely absent) and its author,
 *   the first `from_address_json` entry's `address`, is the lead's own
 *   address. The document does not give that entry's shape: if it is
 *   another, no reply is said to be the person's, and the lane stays shut.
 * - **Only replies the provider types as received** (`ue_type` 2) are
 *   read; one typed otherwise is passed over.
 * - **Only the bound campaigns' replies.** The read is the workspace's
 *   received mail, and a reply from any other campaign, or from none, is
 *   passed over without being kept.
 *
 * The cursor holds `from`, the provider's recording time a read starts at,
 * and, while one is under way, the provider's page cursor and the latest
 * recording time read. When a read reaches its end, the next `from` is that
 * latest time less an overlap: the record of sends was seen to list a send
 * late (README), and replies were not measured. A reply read again is
 * stored once, by its id. A call that reads `scanPages` pages without one
 * reply of a bound campaign returns an empty page with the cursor where it
 * stopped: the pull ends there, and the next one resumes.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";

import type { Inbound, InboundEvent, InboundPage } from "@werunfoundry/acquisition/contracts/inbound";
import { client, fail, type Page } from "../client.js";

/** One email received, as far as this adapter reads it. */
interface Received {
  id: string;
  lead?: string | null;
  campaign_id?: string | null;
  /** 2 for an email received (the API document; seen on 2026-10-22, README). */
  ue_type?: number | null;
  /** 0 not automatic, 1 automatic (the API document). */
  is_auto_reply?: number | null;
  /** "List of from address details": the shape of an entry is not published. */
  from_address_json?: unknown[] | null;
  timestamp_email?: string | null;
  timestamp_created?: string | null;
}

interface Cursor {
  /** The recording time a read starts at. Absent: from the beginning. */
  from?: string;
  /** The provider's cursor for the read under way. */
  page?: string;
  /** The latest recording time the read under way has seen. */
  latest?: string;
}

const encode = (c: Cursor) => Buffer.from(JSON.stringify({ from: c.from, page: c.page, latest: c.latest })).toString("base64url");
function decode(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return {};
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof c === "object" && c !== null ? c : undefined;
  } catch {
    return undefined;
  }
}

/** The first author's address, when the entry has the shape this adapter reads. */
function author(from: unknown[] | null | undefined): string | undefined {
  const first = from?.[0];
  const address = typeof first === "object" && first !== null ? (first as { address?: unknown }).address : undefined;
  return typeof address === "string" && address.includes("@") ? address.trim().toLowerCase() : undefined;
}

const later = (a: string | undefined, b: string | null | undefined) => (b && !Number.isNaN(Date.parse(b)) && (!a || Date.parse(b) > Date.parse(a)) ? b : a);

const factory: AdapterFactory<Inbound> = ({ options, env }) => {
  const call = client({
    token: env.INSTANTLY_API_KEY,
    baseUrl: String(options.baseUrl ?? "https://api.instantly.ai").replace(/\/$/, ""),
    timeoutMs: typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000,
  });
  const overlapMinutes = typeof options.repliesOverlapMinutes === "number" ? options.repliesOverlapMinutes : 60;
  const scanPages = typeof options.scanPages === "number" ? options.scanPages : 10;
  /** Campaign id → its sequence key, from `campaign.<sequenceKey>`. */
  const bound = new Map(
    Object.entries(options)
      .filter(([k, v]) => k.startsWith("campaign.") && typeof v === "string" && v !== "")
      .map(([k, v]) => [v as string, k.slice("campaign.".length)]),
  );

  return {
    provider: "instantly",
    eventTypes: ["acquisition.reply"],

    /** One received email's listing: the read this adapter makes anyway, with the scope it needs anyway. */
    async probe(ctx): Promise<CallResult<void>> {
      const listed = await call<Page<unknown>>("GET", "/api/v2/emails?limit=1&email_type=received&preview_only=true", ctx);
      return listed.ok ? { ok: true, value: undefined } : listed;
    },

    async events({ after, limit }, ctx): Promise<CallResult<InboundPage>> {
      const cursor = decode(after);
      if (!cursor) return fail("invalid", "not a cursor this adapter made");
      if (bound.size === 0) return fail("invalid", "no campaign is bound: add campaign.<sequenceKey>, as on the sequencer binding");

      let { page, latest } = cursor;
      const items: InboundEvent[] = [];
      for (let scanned = 0; scanned < scanPages; scanned++) {
        const query = new URLSearchParams({
          email_type: "received",
          sort_order: "asc",
          preview_only: "true",
          limit: String(Math.min(limit ?? 100, 100)),
          ...(cursor.from ? { min_timestamp_created: cursor.from } : {}),
          ...(page ? { starting_after: page } : {}),
        });
        const read = await call<Page<Received>>("GET", `/api/v2/emails?${query}`, ctx);
        if (!read.ok) return read; // never an empty page: "nothing happened" and "could not ask" differ

        for (const m of read.value.items) {
          latest = later(latest, m.timestamp_created);
          const sequenceKey = m.campaign_id ? bound.get(m.campaign_id) : undefined;
          if (!sequenceKey) continue;
          if (typeof m.ue_type === "number" && m.ue_type !== 2) continue;
          const lead = m.lead?.trim().toLowerCase();
          const occurredAt = m.timestamp_email ?? m.timestamp_created;
          if (!lead || !occurredAt) continue;
          const by = author(m.from_address_json);
          items.push({
            providerEventId: m.id,
            type: "acquisition.reply",
            occurredAt,
            subject: { subject: "person", keys: [{ kind: "email", value: lead }] },
            attribution: { sequenceKey, channel: "email" },
            byThePerson: m.is_auto_reply === 0 && by === lead,
            detail: { automatic: m.is_auto_reply === 0 ? false : m.is_auto_reply === 1 ? true : null, fromTheLead: by === undefined ? null : by === lead },
          });
        }

        const next = read.value.next_starting_after;
        if (!next || read.value.items.length === 0) {
          // The read reached its end: the next one starts an overlap before
          // the latest seen, and never before this one did.
          const from = later(cursor.from, latest ? new Date(Date.parse(latest) - overlapMinutes * 60_000).toISOString() : undefined);
          return { ok: true, value: { items, cursor: encode({ ...(from ? { from } : {}) }) } };
        }
        page = next;
        if (items.length > 0) break;
      }
      return { ok: true, value: { items, cursor: encode({ ...(cursor.from ? { from: cursor.from } : {}), page, ...(latest ? { latest } : {}) }) } };
    },
  };
};

export default factory;
