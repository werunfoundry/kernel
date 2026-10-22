/**
 * Sequencer, sandbox, on the email channel. Enrolments are kept in the
 * sandbox's state file, so that a replay — in this process or the next —
 * finds them. A dry run reads and never writes.
 */

import type { AdapterFactory, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";
import type { EnrolmentStatus, SequenceStep, Sequencer, WayOutWritten, Withdrawal } from "@werunfoundry/acquisition/contracts/sequencer";

import { loadState, saveState, stateFile } from "./sandbox-store.ts";

const emailOf = (p: Identity) => p.keys.find((k) => k.kind === "email")?.value.trim().toLowerCase();
const invalid = (message: string) => ({ ok: false as const, error: { code: "invalid" as const, message, retryable: false } });

/**
 * Where the sandbox reads and writes its state. A test hands the factory
 * another store, to make a write that does not hold: nothing else can show
 * that a read-back refuses what it does not find.
 */
export interface SandboxStore {
  load: typeof loadState;
  save: typeof saveState;
}

export const sequencerOn = (store: SandboxStore = { load: loadState, save: saveState }): AdapterFactory<Sequencer> => ({ options }) => {
  const loadState = store.load;
  const saveState = store.save;
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
      readSteps: { serves: "yes" },
      // Decision 0065: a link of its own, known once the enrolment is made,
      // as the shipped email adapter's is. It goes nowhere: `.invalid`.
      wayOut: {
        offered: "known_after",
        what: "the sandbox's stop link, https://sandbox.invalid/stop/<enrolment key>",
        window: { known: true, seconds: 0, basis: "by construction: the sandbox sends nothing", measuredOn: "2026-10-22" },
      },
    },

    async probe(): Promise<CallResult<void>> {
      const state = loadState(path);
      return state.ok ? { ok: true, value: undefined } : state;
    },

    /**
     * Decision 0064's steps verb. A sequence's steps are the binding's
     * option `steps.<sequenceKey>`: the days each waits after the one
     * before, comma-separated, the first 0 — one step when absent. Each
     * renders `engine_body_<n>`, then `engine_way_out` after it and nothing
     * else (0067), and the first `engine_subject_<n>` too: the later ones go
     * as replies in the thread.
     */
    async readSteps(sequenceKey) {
      const option = options[`steps.${sequenceKey}`];
      const days = (typeof option === "string" ? option : String(option ?? "0")).split(",").map((d) => Number(d.trim()));
      if (days.some((d) => !Number.isInteger(d) || d < 0)) return invalid(`steps.${sequenceKey} is not a list of whole days: "${String(option)}"`);
      const steps: SequenceStep[] = days.map((d, i) => ({
        step: i + 1,
        channel: "email",
        afterPreviousMinutes: d * 24 * 60,
        subject: i === 0 ? { variable: `engine_subject_${i + 1}` } : null,
        body: { variable: `engine_body_${i + 1}` },
        wayOut: { variable: "engine_way_out" },
        variants: 1,
      }));
      return { ok: true, value: { sequenceKey, steps, asOf: new Date().toISOString() } };
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
      state.value.enrolments[e.sequenceKey] = { ...state.value.enrolments[e.sequenceKey], [email]: { key: e.idempotencyKey, at: asOf, ...(e.variables ? { variables: e.variables } : {}) } };
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      return { ok: true, value: { state: "active", sequenceKey: e.sequenceKey, channel: "email", asOf } };
    },

    /**
     * Decision 0067: the way-out line, written into the enrolment's
     * variables once it is made, with every variable it holds written back,
     * then read back from the state file loaded again. Refused for a sequence
     * the state file lists under `wayOutRefused`, so that a run can be seen
     * enrolling someone without one.
     */
    async writeWayOut({ person, sequenceKey, idempotencyKey, variable, line }, ctx): Promise<CallResult<WayOutWritten>> {
      const email = emailOf(person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      const held = state.value.enrolments[sequenceKey]?.[email];
      if (!held || held.key !== idempotencyKey) return { ok: false, error: { code: "not_found", message: "no enrolment under this key in this sequence", retryable: false } };
      if (state.value.wayOutRefused?.includes(sequenceKey)) {
        return { ok: false, error: { code: "unavailable", message: `the sandbox refuses the way out of "${sequenceKey}" (wayOutRefused in its state file)`, retryable: false } };
      }
      const link = `https://sandbox.invalid/stop/${idempotencyKey}`;
      const before = { ...held.variables };
      if (ctx.dryRun) return { ok: true, simulated: true, value: { link, readBack: line(link), readBackAt: new Date().toISOString() } };
      held.variables = { ...before, [variable]: line(link) };
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      const after = loadState(path);
      if (!after.ok) return after;
      const read = after.value.enrolments[sequenceKey]?.[email]?.variables ?? {};
      const lost = Object.keys(before).filter((k) => k !== variable && read[k] !== before[k]);
      if (lost.length > 0) return { ok: false, error: { code: "unknown", message: `the state file, read back, changed ${lost.join(", ")}`, retryable: false } };
      return { ok: true, value: { link, readBack: read[variable] ?? "", readBackAt: new Date().toISOString() } };
    },

    async withdraw({ person, sequenceKey }, ctx): Promise<CallResult<Withdrawal>> {
      const email = emailOf(person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      const asOf = new Date().toISOString();
      const held = state.value.enrolments[sequenceKey]?.[email];
      if (!held) return { ok: true, value: { found: false, asOf } };
      // The key its record holds, as the read found it (0060): what tells the
      // kernel this is the enrolment it made.
      if (ctx.dryRun) return { ok: true, simulated: true, value: { found: true, idempotencyKey: held.key, asOf } };
      delete state.value.enrolments[sequenceKey]![email];
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      // Read back, as 0051 asks: the state file, loaded again, must no longer hold them.
      const after = loadState(path);
      if (!after.ok) return after;
      if (after.value.enrolments[sequenceKey]?.[email]) {
        return { ok: false, error: { code: "unknown", message: "the enrolment is still in the state file after its deletion", retryable: false } };
      }
      return { ok: true, value: { found: true, readBack: { sequenceKey, enrolled: false }, idempotencyKey: held.key, asOf } };
    },

    async suppress({ target }, ctx) {
      const applied = target.keys.filter((k) => k.kind === "email" || k.kind === "domain");
      const notApplicable = target.keys.filter((k) => k.kind !== "email" && k.kind !== "domain");
      if (applied.length === 0) return invalid("none of this identity's keys is an email or a domain");
      // As the sandbox compares them at enrolment: an address in lower case,
      // a domain as its host (0028), so that `https://WWW.Example.org/about`
      // stops `ada@example.org` rather than being listed as written.
      const listed = (k: (typeof applied)[number]) => (k.kind === "domain" ? hostOf(k.value) : k.value.trim().toLowerCase());
      const state = loadState(path);
      if (!state.ok) return state;
      // A dry run writes nothing: its answer rests on the read before (0051).
      if (ctx.dryRun) return { ok: true, simulated: true, value: { applied, notApplicable, asOf: new Date().toISOString() } };
      for (const k of applied) if (!state.value.suppressed.includes(listed(k))) state.value.suppressed.push(listed(k));
      const saved = saveState(path, state.value);
      if (!saved.ok) return saved;
      // Read back, as 0051 asks: every key reported applied must be listed in
      // the state file, loaded again, and `asOf` is when that read was made.
      const after = loadState(path);
      const asOf = new Date().toISOString();
      if (!after.ok) return after;
      const missing = applied.filter((k) => !after.value.suppressed.includes(listed(k)));
      if (missing.length > 0) {
        return { ok: false, error: { code: "unknown", message: `the state file, read back, lists ${applied.length - missing.length} of the ${applied.length} keys written`, retryable: false } };
      }
      return { ok: true, value: { applied, notApplicable, asOf } };
    },

    async status({ person, sequenceKey }) {
      const email = emailOf(person);
      if (!email) return invalid("the sandbox reaches a person by email; this identity has none");
      const state = loadState(path);
      if (!state.ok) return state;
      const held = state.value.enrolments[sequenceKey]?.[email];
      return { ok: true, value: held ? { state: "active", sequenceKey, channel: "email", idempotencyKey: held.key, asOf: held.at } : { state: "unknown", sequenceKey, asOf: new Date().toISOString() } };
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

export default sequencerOn();
