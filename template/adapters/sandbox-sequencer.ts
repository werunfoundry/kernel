/**
 * Sequencer, sandbox, on the email channel. Enrolments are kept in the
 * sandbox's state file, so that a replay — in this process or the next —
 * finds them. A dry run reads and never writes.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import type { EnrolmentStatus, Sequencer, Withdrawal } from "@werunfoundry/acquisition/contracts/sequencer";

import { loadState, saveState, stateFile } from "./sandbox-store.ts";

const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value.trim().toLowerCase();
const invalid = (message: string) => ({ ok: false as const, error: { code: "invalid" as const, message, retryable: false } });

const factory: AdapterFactory<Sequencer> = ({ options }) => {
  const path = stateFile(options.stateFile);
  const dailyLimit = typeof options.dailyLimit === "number" ? options.dailyLimit : 50;

  return {
    provider: "sandbox-sequencer",
    channels: ["email"],

    // Decision 0051. The sandbox sends nothing, and stops someone by deleting
    // their enrolment from its state file — the only way it has.
    declares: {
      enrol: { serves: "yes" },
      pullTouches: { serves: "no", why: "the sandbox records enrolments, not sends" },
      suspend: {
        serves: "yes",
        method: "deleting the enrolment from the state file",
        costs: { person: ["sequence_link_lost", "provider_record_lost", "irreversible"], sequence: [] },
        gap: { known: true, minutes: 0, basis: "by construction: the sandbox sends nothing, and the deletion is synchronous", measuredOn: "2026-10-20" },
      },
      pullUnsubscribes: { serves: "no", why: "nobody can unsubscribe from the sandbox" },
    },

    async probe(): Promise<CallResult<void>> {
      const state = loadState(path);
      return state.ok ? { ok: true, value: undefined } : state;
    },

    async enrol(e, ctx): Promise<CallResult<EnrolmentStatus>> {
      if (e.channel !== "email") return invalid(`the sandbox serves the channel "email" only, not "${e.channel}"`);
      const email = emailOf(e.person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      if (state.value.suppressed.includes(email) || state.value.suppressed.includes(email.split("@")[1] ?? "")) {
        return invalid("this person is suppressed");
      }
      const held = state.value.enrolments[e.sequenceKey]?.[email];
      const asOf = new Date().toISOString();
      if (held) {
        if (held.key !== e.idempotencyKey) {
          return { ok: false, error: { code: "conflict", message: "already in this sequence under another key", retryable: false } };
        }
        return { ok: true, value: { state: "active", sequenceKey: e.sequenceKey, channel: "email", asOf: held.at } };
      }
      if (ctx.dryRun) return { ok: true, simulated: true, value: { state: "active", sequenceKey: e.sequenceKey, channel: "email", asOf } };
      state.value.enrolments[e.sequenceKey] = { ...state.value.enrolments[e.sequenceKey], [email]: { key: e.idempotencyKey, at: asOf } };
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      return { ok: true, value: { state: "active", sequenceKey: e.sequenceKey, channel: "email", asOf } };
    },

    async withdraw({ person, sequenceKey }, ctx): Promise<CallResult<Withdrawal>> {
      const email = emailOf(person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      const asOf = new Date().toISOString();
      if (!state.value.enrolments[sequenceKey]?.[email]) return { ok: true, value: { found: false, asOf } };
      if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, asOf } };
      delete state.value.enrolments[sequenceKey]![email];
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      // Read back, as 0051 asks: the state file, loaded again, must no longer hold them.
      const after = loadState(path);
      if (!after.ok) return after;
      if (after.value.enrolments[sequenceKey]?.[email]) {
        return { ok: false, error: { code: "unknown", message: "the enrolment is still in the state file after its deletion", retryable: false } };
      }
      return { ok: true, value: { found: true, readBack: { sequenceKey, enrolled: false }, asOf } };
    },

    async suppress({ target }, ctx) {
      const applied = target.keys.filter((k) => k.kind === "email" || k.kind === "domain");
      const notApplicable = target.keys.filter((k) => k.kind !== "email" && k.kind !== "domain");
      if (applied.length === 0) return invalid("none of this identity's keys is an email or a domain");
      const state = loadState(path);
      if (!state.ok) return state;
      if (!ctx.dryRun) {
        for (const k of applied) {
          const v = k.value.trim().toLowerCase();
          if (!state.value.suppressed.includes(v)) state.value.suppressed.push(v);
        }
        const saved = saveState(path, state.value);
        if (!saved.ok) return saved;
      }
      return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { applied, notApplicable, asOf: new Date().toISOString() } };
    },

    async status({ person, sequenceKey }) {
      const email = emailOf(person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      const held = state.value.enrolments[sequenceKey]?.[email];
      return { ok: true, value: held ? { state: "active", sequenceKey, channel: "email", asOf: held.at } : { state: "unknown", sequenceKey, asOf: new Date().toISOString() } };
    },

    async capacity({ sender, channel }) {
      if (channel !== "email") return invalid(`the sandbox serves the channel "email" only, not "${channel}"`);
      const state = loadState(path);
      if (!state.ok) return state;
      const today = new Date().toISOString().slice(0, 10);
      const used = Object.values(state.value.enrolments).flatMap((s) => Object.values(s)).filter((x) => x.at.startsWith(today)).length;
      return {
        ok: true,
        value: {
          sender,
          channel,
          limits: [{ unit: "messages", window: "day", limit: dailyLimit, used, remaining: Math.max(0, dailyLimit - used) }],
          asOf: new Date().toISOString(),
        },
      };
    },
  };
};

export default factory;
