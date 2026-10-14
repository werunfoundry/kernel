/**
 * core/manifest — which experiment types the bound metric sources can judge
 * (decision 0018), channel by channel.
 *
 * A metric a domain scopes to some channels is not applicable on the others.
 * Not applicable is neither missing nor present: it is not counted at all.
 * That is 0009's rule for probes, applied to numbers — what was not asked has
 * not answered, and is never reported as health. Two consequences:
 *
 * - a guardrail that cannot exist on a channel does not make a type
 *   unmeasurable there, and does not make it measurable either;
 * - a channel on which none of a type's metrics applies is never measurable
 *   for that type: it would be measurable on the faith of nothing.
 *
 * Pure: it reads what the domains declare and what the sources say they can
 * read. It says nothing about whether a number is good.
 */

import type { CallContext, CallResult, MetricQuery, MetricReading, MetricSource } from "../contracts/types.js";
import type { DomainManifest, MetricDeclaration } from "./types.js";

export interface ChannelMeasurability {
  /** Absent when no enabled domain declares channels: every metric applies. */
  channel?: string;
  /** The type's metrics that mean something on this channel. */
  applicable: string[];
  /** Those that do not. Not missing, not counted. */
  notApplicable: string[];
  /** Applicable ones no bound source reads. */
  missing: string[];
  /** At least one applicable metric, and every applicable one readable. */
  measurable: boolean;
}

export interface Measurability {
  experimentType: string;
  /** The metrics the type is judged on. */
  metrics: string[];
  /** Judged on a metric no bound source reads, on some channel where it applies. */
  missing: string[];
  channels: ChannelMeasurability[];
  /**
   * Measurable on at least one channel, and missing nothing anywhere a metric
   * applies. A type judged on nothing, or only on metrics that apply nowhere,
   * is not measurable.
   */
  measurable: boolean;
}

/** Whether a declared metric means something on a channel. Unscoped metrics apply everywhere. */
export function metricApplies(declaration: MetricDeclaration | undefined, channel: string | undefined): boolean {
  if (!declaration?.channels || channel === undefined) return true;
  return declaration.channels.includes(channel);
}

export function measurability(
  domains: readonly DomainManifest[],
  sources: readonly { metrics: readonly string[] }[],
): Measurability[] {
  const readable = new Set(sources.flatMap((s) => s.metrics));
  const declarations = new Map(domains.flatMap((d) => d.metrics ?? []).map((m) => [m.key, m]));
  const channels: (string | undefined)[] = [...new Set(domains.flatMap((d) => d.channels ?? []))];
  if (channels.length === 0) channels.push(undefined);

  const out: Measurability[] = [];
  for (const d of domains) {
    for (const type of d.experimentTypes ?? []) {
      const metrics = d.experimentMetrics?.[type] ?? [];
      const perChannel = channels.map((channel): ChannelMeasurability => {
        const applicable = metrics.filter((m) => metricApplies(declarations.get(m), channel));
        const missing = applicable.filter((m) => !readable.has(m));
        return {
          ...(channel === undefined ? {} : { channel }),
          applicable,
          notApplicable: metrics.filter((m) => !applicable.includes(m)),
          missing,
          measurable: applicable.length > 0 && missing.length === 0,
        };
      });
      const missing = [...new Set(perChannel.flatMap((c) => c.missing))];
      out.push({
        experimentType: type,
        metrics,
        missing,
        channels: perChannel,
        measurable: perChannel.some((c) => c.measurable) && missing.length === 0,
      });
    }
  }
  return out;
}

/**
 * Read one metric, refusing to let "not applicable" become a number.
 *
 * If the domains scope the metric away from the queried channel, the source
 * is not asked: the answer is not applicable, whatever the source would have
 * said. A source that answers a number for a query the kernel can tell is
 * inapplicable never gets the chance.
 */
export async function readMetric(
  source: MetricSource,
  query: MetricQuery,
  declarations: readonly MetricDeclaration[],
  ctx: CallContext,
): Promise<CallResult<MetricReading>> {
  const declared = declarations.find((m) => m.key === query.key);
  if (!metricApplies(declared, query.channel)) {
    return {
      ok: true,
      value: {
        key: query.key,
        applicable: false,
        why: `"${query.key}" does not apply on the channel "${query.channel}"`,
        asOf: new Date().toISOString(),
        source: "kernel",
      },
    };
  }
  return source.read(query, ctx);
}
