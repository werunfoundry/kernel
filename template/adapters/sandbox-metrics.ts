/**
 * Metric source, sandbox. Reads every metric a acquisition experiment type is judged
 * on, guardrails included, from the sandbox's own data and state. A key it
 * does not read is refused, never answered with zero; a zero it does answer
 * is a count of invented events that happens to be zero.
 */

import type { AdapterFactory, CallResult, MetricReading, MetricSource } from "@werunfoundry/core/contracts/types";

import { loadData, loadState, stateFile } from "./sandbox-store.ts";

const factory: AdapterFactory<MetricSource> = ({ options }) => ({
  provider: "sandbox-metrics",
  metrics: ["acquisition.enrolled", "acquisition.replied", "acquisition.meetings_booked", "acquisition.bounced", "acquisition.unsubscribed"],

  async probe(): Promise<CallResult<void>> {
    const data = loadData(options.dataFile);
    return data.ok ? { ok: true, value: undefined } : data;
  },

  async read(query): Promise<CallResult<MetricReading>> {
    const data = loadData(options.dataFile);
    if (!data.ok) return data;
    const state = loadState(stateFile(options.stateFile));
    if (!state.ok) return state;
    const asOf = new Date().toISOString();
    const reading = (value: number, unit: string): CallResult<MetricReading> => ({
      ok: true,
      value: { key: query.key, applicable: true, value, unit, asOf, source: "sandbox-metrics" },
    });
    // Bounces and unsubscribes exist on email only. Asked about another
    // channel, the answer is that there is no number — never a zero.
    if ((query.key === "acquisition.bounced" || query.key === "acquisition.unsubscribed") && query.channel && query.channel !== "email") {
      return {
        ok: true,
        value: { key: query.key, applicable: false, why: `no ${query.key} on ${query.channel}`, asOf, source: "sandbox-metrics" },
      };
    }
    const events = (type: string) => new Set(data.value.events.filter((e) => e.type === type).map((e) => e.email)).size;
    if (query.key === "acquisition.enrolled") {
      return reading(Object.values(state.value.enrolments).reduce((n, s) => n + Object.keys(s).length, 0), "people");
    }
    if (query.key === "acquisition.replied") return reading(events("acquisition.reply"), "people");
    if (query.key === "acquisition.meetings_booked") return reading(data.value.events.filter((e) => e.type === "acquisition.meeting_booked").length, "meetings");
    if (query.key === "acquisition.bounced") return reading(events("acquisition.bounce"), "people");
    if (query.key === "acquisition.unsubscribed") return reading(events("acquisition.unsubscribe"), "people");
    return { ok: false, error: { code: "invalid", message: `the sandbox does not read "${query.key}"`, retryable: false } };
  },
});

export default factory;
