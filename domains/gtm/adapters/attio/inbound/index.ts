/**
 * gtm/adapters/attio/inbound — the gtm `Inbound` contract, against Attio.
 *
 *   - contract: inbound
 *     adapter: "@werunfoundry/gtm/adapters/attio/inbound"
 *     env: [ATTIO_API_KEY]
 *     options:
 *       internalDomains: "example.com,example.org"   # your own; their people are not events
 *
 * It produces one event type, `gtm.meeting_booked`, and the record should say
 * why only that one, because the others were looked for:
 *
 * - **Replies are not readable as a feed.** `GET /v2/emails` requires a
 *   participant, a linked record or a domain — "there is no way to list every
 *   email", in Attio's words — and is an alpha enabled per workspace on
 *   request. A reply source is the sequencer's, not the CRM's.
 * - **Bounces and unsubscribes** are the sending tool's facts, not the CRM's.
 * - **A signup is not a record creation.** Records are created by every path
 *   into the CRM, this engine's `register` included.
 *
 * Meetings are a feed: `GET /v2/meetings` lists every meeting in a
 * deterministic order, sorted by start and filtered by `ends_from`. It cannot
 * be sorted or filtered by creation time, so the cursor is a time line, not a
 * change log:
 *
 * - The cursor holds `from`, when the previous read began, and, while one is
 *   under way, Attio's page cursor. A read asks for meetings ending after
 *   `from`. When it reaches the last page, the next `from` is when it began.
 * - A meeting still to come is read again on every pass until it has ended.
 *   That is the at-least-once the contract allows; `providerEventId` is
 *   stable (`<meeting>:<participant>`), so it is stored once.
 * - A meeting created after a read began but ending before it — a past
 *   meeting logged late — is not seen. Recorded rather than hidden.
 *
 * One event per external participant: not the organiser, not one who
 * declined, and not an address on a domain the instance lists as its own.
 * `occurredAt` is when the meeting was created, which is when it was booked.
 * No attribution: Attio does not know which run led to a meeting, and the
 * engine ties the event to one through the participant's identity.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";

import type { InboundEvent, InboundPage, Inbound } from "../../../contracts/inbound.js";
import { DEFAULT_BASE_URL, client, fail } from "../client.js";

interface Meeting {
  id: { meeting_id: string };
  created_at: string;
  participants?: { email_address?: string; is_organizer?: boolean; status?: string }[];
}

interface Cursor {
  /** Meetings ending after this were not all read yet. Absent: from the beginning. */
  from?: string;
  /** Attio's cursor for the read under way. */
  page?: string;
  /** When the read under way began: the next `from`. */
  began?: string;
}

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return {};
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    return typeof c === "object" && c !== null ? c : undefined;
  } catch {
    return undefined;
  }
}

const factory: AdapterFactory<Inbound> = ({ options, env }) => {
  const { call, probe } = client(
    env.ATTIO_API_KEY,
    String(options.baseUrl ?? DEFAULT_BASE_URL),
    typeof options.timeoutMs === "number" ? options.timeoutMs : undefined,
  );
  const internal = new Set(
    String(options.internalDomains ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );

  return {
    provider: "attio",
    eventTypes: ["gtm.meeting_booked"],
    probe,

    async events({ after, limit }, ctx): Promise<CallResult<InboundPage>> {
      const cursor = decode(after);
      if (!cursor) return fail("invalid", "not a cursor this adapter made");
      const began = cursor.began ?? new Date().toISOString();

      const query = new URLSearchParams({ sort: "start_asc", limit: String(limit ?? 50) });
      if (cursor.from) query.set("ends_from", cursor.from);
      if (cursor.page) query.set("cursor", cursor.page);
      const listed = await call<{ data: Meeting[]; pagination: { next_cursor: string | null } }>("GET", `/v2/meetings?${query}`, ctx);
      if (!listed.ok) return listed; // never an empty page: "nothing happened" and "could not ask" differ

      const items: InboundEvent[] = [];
      for (const meeting of listed.value.data) {
        for (const p of meeting.participants ?? []) {
          const email = p.email_address?.trim().toLowerCase();
          if (!email || p.is_organizer || p.status === "declined") continue;
          if (internal.has(email.split("@")[1] ?? "")) continue;
          items.push({
            providerEventId: `${meeting.id.meeting_id}:${email}`,
            type: "gtm.meeting_booked",
            occurredAt: meeting.created_at,
            subject: { subject: "person", keys: [{ kind: "email", value: email }] },
            ...(p.status ? { detail: { participantStatus: p.status } } : {}),
          });
        }
      }

      const next = listed.value.pagination.next_cursor;
      const nextCursor: Cursor = next ? { ...(cursor.from ? { from: cursor.from } : {}), page: next, began } : { from: began };
      return { ok: true, value: { items, cursor: encode(nextCursor) } };
    },
  };
};

export default factory;
