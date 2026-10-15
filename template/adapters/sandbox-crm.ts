/**
 * CRM, sandbox. Knows the companies and people the invented data says it
 * holds (`crm`), and what it is asked to register, kept in the sandbox's
 * state file. For a CRM you
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
      const d = domain.toLowerCase();
      if (!(data.value.crm?.companies ?? []).includes(d)) return { ok: true, value: null };
      const c = data.value.companies.find((x) => x.domain === d);
      return { ok: true, value: { ref: { externalId: c?.externalId ?? d }, ...(c ? { name: c.name } : {}), domain: d, fields: {} } };
    },

    async findPersonByEmail(email) {
      const data = loadData(options.dataFile);
      if (!data.ok) return data;
      // What the CRM was seeded with, and what it was asked to register.
      const e = email.toLowerCase();
      const state = loadState(path);
      if (!state.ok) return state;
      if (!(data.value.crm?.people ?? []).includes(e) && !state.value.crm.some((r) => r.email === e)) return { ok: true, value: null };
      const p = data.value.people.find((x) => x.email === e);
      return { ok: true, value: { ref: { externalId: e }, email: e, ...(p ? { fullName: p.name } : {}), fields: {} } };
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
