/**
 * CRM, sandbox. Looks companies and people up in invented data, and keeps
 * what it is asked to register in the sandbox's state file. For a CRM you
 * can reach, start from `example-crm.ts`, which talks to an API.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Crm, CrmRegistrationResult } from "@werunfoundry/relations/contracts/crm";

import { loadData, loadState, saveState, stateFile } from "./sandbox-store.ts";

const factory: AdapterFactory<Crm> = ({ options }) => {
  const path = stateFile(options.stateFile);
  return {
    provider: "sandbox-crm",

    async probe(): Promise<CallResult<void>> {
      const data = loadData(options.dataFile);
      return data.ok ? { ok: true, value: undefined } : data;
    },

    async findCompanyByDomain(domain) {
      const data = loadData(options.dataFile);
      if (!data.ok) return data;
      const c = data.value.companies.find((x) => x.domain === domain.toLowerCase());
      return { ok: true, value: c ? { ref: { externalId: c.externalId }, name: c.name, domain: c.domain, fields: {} } : null };
    },

    async findPersonByEmail(email) {
      const data = loadData(options.dataFile);
      if (!data.ok) return data;
      const p = data.value.people.find((x) => x.email === email.toLowerCase());
      return { ok: true, value: p ? { ref: { externalId: p.email }, email: p.email, fullName: p.name, fields: {} } : null };
    },

    async register(registration, ctx): Promise<CallResult<CrmRegistrationResult>> {
      const email = registration.person.email?.toLowerCase();
      if (!email) return { ok: false, error: { code: "invalid", message: "a person needs an email here", retryable: false } };
      const state = loadState(path);
      if (!state.ok) return state;
      const person = { ref: { externalId: email }, email, fields: {} };
      if (state.value.crm.some((r) => r.email === email)) return { ok: true, value: { person, existed: true } };
      if (ctx.dryRun) return { ok: true, simulated: true, value: { person, existed: false } };
      state.value.crm.push({ email, reason: registration.reason });
      const saved = saveState(path, state.value);
      return saved.ok ? { ok: true, value: { person, existed: false } } : saved;
    },

    async annotate(note, ctx) {
      if (ctx.dryRun) return { ok: true, simulated: true, value: undefined };
      const state = loadState(path);
      if (!state.ok) return state;
      state.value.notes.push({ subject: note.subject.externalId, body: note.body, at: note.occurredAt });
      return saveState(path, state.value);
    },
  };
};

export default factory;
