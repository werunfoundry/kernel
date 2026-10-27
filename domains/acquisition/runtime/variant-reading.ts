/**
 * acquisition/runtime — the one reading of a metric by variant (decision 0072).
 *
 * A variant is an arm of an experiment, or a correction of one: a template
 * recorded after drafting, reaching only the people not drafted yet, so
 * chosen by when they were drafted and not at random. Compared with the arm
 * it corrects as if they were randomised arms, it gives the false conclusion
 * the system exists to prevent.
 *
 * The core cannot hold that mark: it knows no variant and no template. So the
 * reading by variant is here, and its answer carries the mark beside the
 * number — `corrects`, the arm this variant corrects, or `null` for an arm.
 * A caller cannot have the number without the mark in its hands, and decides
 * what to do with it. `scripts/check.mjs` holds that this is the one place a
 * variant is put in a metric query.
 *
 * The source is asked through `readMetric`, so a metric that does not apply
 * on the channel is still "not applicable", never zero (0021).
 */

import { and, eq } from "drizzle-orm";

import type { CallContext, CallResult, MetricReading, MetricSource } from "@werunfoundry/core/contracts/types";
import { experiment } from "@werunfoundry/core/db/schema";
import type { MetricDeclaration } from "@werunfoundry/core/manifest/types";
import { readMetric } from "@werunfoundry/core/manifest";
import type { Database } from "@werunfoundry/core/runtime/run";

import { template } from "../db/schema.js";

export interface VariantReading {
  reading: MetricReading;
  variant: string;
  /** The arm this variant corrects, or null for an arm: never left out. */
  corrects: string | null;
}

export async function readByVariant(
  deps: { db: Database; source: MetricSource; declarations: readonly MetricDeclaration[] },
  query: { experimentId: string; variant: string; key: string; channel?: string; window?: { from: string; to: string } },
  ctx: CallContext,
): Promise<CallResult<VariantReading>> {
  const [exp] = await deps.db.select({ slug: experiment.slug }).from(experiment).where(eq(experiment.id, query.experimentId));
  if (!exp) return { ok: false, error: { code: "invalid", message: "the experiment is not on record", retryable: false } };
  const [mark] = await deps.db
    .select({ corrects: template.corrects })
    .from(template)
    .where(and(eq(template.experimentId, query.experimentId), eq(template.variant, query.variant)))
    .limit(1);
  if (!mark) return { ok: false, error: { code: "invalid", message: `the experiment ${exp.slug} has no variant "${query.variant}"`, retryable: false } };
  const read = await readMetric(
    deps.source,
    {
      key: query.key,
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.window ? { window: query.window } : {}),
      params: { experiment: exp.slug, variant: query.variant },
    },
    deps.declarations,
    ctx,
  );
  if (!read.ok) return read;
  return { ok: true, value: { reading: read.value, variant: query.variant, corrects: mark.corrects } };
}
