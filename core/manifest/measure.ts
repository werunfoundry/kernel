/**
 * core/manifest — which experiment types the bound metric sources can judge
 * (decision 0018).
 *
 * Pure: it reads what the domains declare and what the sources say they can
 * read. It says nothing about whether a number is good — only whether there
 * is a number at all.
 */

import type { DomainManifest } from "./types.js";

export interface Measurability {
  experimentType: string;
  /** The metrics the type is judged on. */
  metrics: string[];
  /** Those no bound source can read. */
  missing: string[];
  /**
   * At least one metric, and every one readable. A type judged on nothing is
   * not measurable — an empty `missing` would otherwise say it was.
   */
  measurable: boolean;
}

export function measurability(
  domains: readonly DomainManifest[],
  sources: readonly { metrics: readonly string[] }[],
): Measurability[] {
  const readable = new Set(sources.flatMap((s) => s.metrics));
  const out: Measurability[] = [];
  for (const d of domains) {
    for (const type of d.experimentTypes ?? []) {
      const metrics = d.experimentMetrics?.[type] ?? [];
      const missing = metrics.filter((m) => !readable.has(m));
      out.push({ experimentType: type, metrics, missing, measurable: metrics.length > 0 && missing.length === 0 });
    }
  }
  return out;
}
