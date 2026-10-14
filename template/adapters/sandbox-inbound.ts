/**
 * Inbound, sandbox. Invented events, read after a cursor that is their
 * position. The cursor comes back with every page, even an empty one.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Inbound } from "@werunfoundry/gtm/contracts/inbound";

import { loadData } from "./sandbox-store.ts";

const factory: AdapterFactory<Inbound> = ({ options }) => ({
  provider: "sandbox-inbound",
  eventTypes: ["gtm.reply", "gtm.meeting_booked"],

  async probe(): Promise<CallResult<void>> {
    const data = loadData(options.dataFile);
    return data.ok ? { ok: true, value: undefined } : data;
  },

  async events({ after, limit }) {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const start = Number(after ?? 0);
    const items = data.value.events.slice(start, start + (limit ?? 100)).map((e) => ({
      providerEventId: e.id,
      type: e.type,
      occurredAt: e.occurredAt,
      subject: { subject: "person", keys: [{ kind: "email", value: e.email }] },
    }));
    return { ok: true, value: { items, cursor: String(start + items.length) } };
  },
});

export default factory;
