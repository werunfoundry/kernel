/**
 * Metric source, sandbox. Reads the three metrics every gtm experiment type
 * is judged on, from the sandbox's own data and state. A key it does not
 * read is refused, never answered with zero.
 */

import type { AdapterFactory, CallResult, MetricReading, MetricSource } from "@werunfoundry/core/contracts/types";

import { loadData, loadState, stateFile } from "./sandbox-store.ts";

const factory: AdapterFactory<MetricSource> = ({ options }) => ({
  provider: "sandbox-metrics",
  metrics: ["gtm.enrolled", "gtm.replied", "gtm.meetings_booked"],

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
      value: { key: query.key, value, unit, asOf, source: "sandbox-metrics" },
    });
    const events = (type: string) => new Set(data.value.events.filter((e) => e.type === type).map((e) => e.email)).size;
    if (query.key === "gtm.enrolled") {
      return reading(Object.values(state.value.enrolments).reduce((n, s) => n + Object.keys(s).length, 0), "people");
    }
    if (query.key === "gtm.replied") return reading(events("gtm.reply"), "people");
    if (query.key === "gtm.meetings_booked") return reading(data.value.events.filter((e) => e.type === "gtm.meeting_booked").length, "meetings");
    return { ok: false, error: { code: "invalid", message: `the sandbox does not read "${query.key}"`, retryable: false } };
  },
});

export default factory;
