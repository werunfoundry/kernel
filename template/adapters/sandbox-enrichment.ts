/**
 * Enrichment, sandbox. The people at a company, by domain, from invented
 * data. A company it has no record of is a search that found nobody — not an
 * error. Data it cannot read is an error — not nobody.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Enrichment } from "@werunfoundry/relations/contracts/enrichment";

import { loadData } from "./sandbox-store.ts";

const factory: AdapterFactory<Enrichment> = ({ options }) => ({
  provider: "sandbox-enrichment",

  async probe(): Promise<CallResult<void>> {
    const data = loadData(options.dataFile);
    return data.ok ? { ok: true, value: undefined } : data;
  },

  async peopleAt({ company, limit }) {
    const domain = company.keys.find((k) => k.kind === "domain")?.value.toLowerCase();
    if (!domain) return { ok: false, error: { code: "invalid", message: "the sandbox finds people by a company's domain", retryable: false } };
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const items = data.value.people
      .filter((p) => p.domain === domain)
      .slice(0, limit ?? 25)
      .map((p) => ({
        identity: { subject: "person", keys: [{ kind: "email", value: p.email }] },
        display: { fullName: p.name, ...(p.title ? { title: p.title } : {}) },
      }));
    return { ok: true, value: { items, asOf: new Date().toISOString() } };
  },

  async complete({ identity }) {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const email = identity.keys.find((k) => k.kind === "email")?.value.toLowerCase();
    const known = data.value.people.find((p) => p.email === email);
    const asOf = new Date().toISOString();
    // What the record says, not what was asked (0022). It holds only an
    // address, which is mutable, so the contract never accepts this answer.
    return {
      ok: true,
      value: known ? { found: true, attested: { subject: "person", keys: [{ kind: "email", value: known.email }] }, asOf } : { found: false, asOf },
    };
  },
});

export default factory;
