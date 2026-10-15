/**
 * People source and enrichment, sandbox — one module, bound once under each
 * contract (0030). The people at a company, by domain, from invented
 * data. A company it has no record of is a search that found nobody — not an
 * error. Data it cannot read is an error — not nobody.
 *
 * It shows the shape of a completion the contract accepts (0022). Each person
 * carries an invented profile id on the network the binding names, which must
 * be one of the instance's `networks`. `peopleAt` returns it, so the caller
 * holds an immutable key to complete by; `complete` returns what the record
 * says — its id and its address — and never a key copied from the request.
 * An identity known only by its address is answered too, and the contract
 * rejects that answer: nothing immutable ties it to the person asked about.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Enrichment } from "@werunfoundry/relations/contracts/enrichment";
import type { PeopleSource } from "@werunfoundry/relations/contracts/people-source";

import { loadData } from "./sandbox-store.ts";

const factory: AdapterFactory<PeopleSource & Enrichment> = ({ options }) => {
  const network = String(options.network ?? "sandbox");
  const keysOf = (p: { email: string; profileId: string }) => [
    { kind: "email", value: p.email },
    { kind: "social_profile_id", network, value: p.profileId },
  ];

  return {
    provider: "sandbox-enrichment",
    finds: ["email"],

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
          identity: { subject: "person", keys: keysOf(p) },
          display: { fullName: p.name, ...(p.title ? { title: p.title } : {}) },
        }));
      return { ok: true, value: { items, asOf: new Date().toISOString() } };
    },

    async complete({ identity }) {
      const data = loadData(options.dataFile);
      if (!data.ok) return data;
      const profileId = identity.keys.find((k) => k.kind === "social_profile_id" && k.network === network)?.value;
      const email = identity.keys.find((k) => k.kind === "email")?.value.toLowerCase();
      const known = profileId !== undefined ? data.value.people.find((p) => p.profileId === profileId) : data.value.people.find((p) => p.email === email);
      const asOf = new Date().toISOString();
      // What the record says, not what was asked (0022).
      return { ok: true, value: known ? { found: true, attested: { subject: "person", keys: keysOf(known) }, asOf } : { found: false, asOf } };
    },
  };
};

export default factory;
