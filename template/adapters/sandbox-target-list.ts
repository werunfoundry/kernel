/**
 * Target list, sandbox. Candidates and protected accounts from invented
 * data. Its freshness is now: the data is read again on every call, and it
 * says so rather than claiming an age it does not have.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { TargetList } from "@werunfoundry/gtm/contracts/target-list";

import { loadData } from "./sandbox-store.ts";

const factory: AdapterFactory<TargetList> = ({ options }) => ({
  provider: "sandbox-target-list",

  async probe(): Promise<CallResult<void>> {
    const data = loadData(options.dataFile);
    return data.ok ? { ok: true, value: undefined } : data;
  },

  async freshness(route) {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    return { ok: true, value: { route, asOf: new Date().toISOString(), declaredMaxLagMinutes: 0 } };
  },

  async candidates(query) {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const items = data.value.companies.slice(0, query.limit ?? 100).map((c) => ({
      domain: c.domain,
      name: c.name,
      externalId: c.externalId,
      attributes: {},
    }));
    return { ok: true, value: { items } };
  },

  async protectedAccounts(query) {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const start = Number(query.cursor ?? 0);
    const size = query.limit ?? 100;
    const items = data.value.protected.slice(start, start + size);
    const next = start + size;
    return { ok: true, value: { items, ...(next < data.value.protected.length ? { nextCursor: String(next) } : {}) } };
  },
});

export default factory;
