/**
 * acquisition/runtime — a person records a template (decision 0072): one step
 * of one variant of an experiment, what every draft of that step will say.
 *
 * A template is never rewritten; the DDL refuses an update. At a step that
 * already has one, `replace` withdraws it and records the new one in the
 * same transaction — which the schema allows only while no draft cites it.
 * Once one does, a correction is a new variant that names the arm it
 * corrects (`corrects`), carries every step, and reaches only the people not
 * drafted yet. Its mark is held by the DDL: the same on every step, and an
 * arm, never another correction.
 *
 * Each record is its own run, with the person as its actor.
 */

import { and, asc, eq } from "drizzle-orm";

import { experiment } from "@werunfoundry/core/db/schema";
import type { Database, Trigger } from "@werunfoundry/core/runtime/run";
import { openRun } from "@werunfoundry/core/runtime/run";

import { template } from "../db/schema.js";

export interface TemplateToRecord {
  experimentId: string;
  variant: string;
  step: number;
  channel: string;
  subject?: string;
  body: string;
  delayDays?: number;
  /** The arm this variant corrects, when it is a correction (0072). */
  corrects?: string;
}

export type Template = typeof template.$inferSelect;

/** Why a template cannot be recorded as given, or nothing. Reads nothing. */
export function checkTemplate(input: TemplateToRecord, declaredChannels: ReadonlySet<string>): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.variant)) return "a variant is lowercase letters, digits and dashes: it travels to the provider with the enrolment";
  if (!Number.isInteger(input.step) || input.step < 1) return "a step is a whole number from 1";
  if (!declaredChannels.has(input.channel)) return `no enabled domain declares the channel "${input.channel}"`;
  if (!input.body.trim()) return "a template has a body";
  if (input.subject !== undefined && !input.subject.trim()) return "a subject, when there is one, is not empty";
  if (input.delayDays !== undefined && (!Number.isInteger(input.delayDays) || input.delayDays < 0)) return "a delay is a whole number of days, from 0";
  return undefined;
}

/** The experiment's templates, variant by variant, step by step. */
export async function templatesOf(db: Database, experimentId: string): Promise<Template[]> {
  return db.select().from(template).where(eq(template.experimentId, experimentId)).orderBy(asc(template.variant), asc(template.step));
}

/** What a start needs from this domain (0072): at least one template. */
export async function readyToStart(db: Database, experimentId: string): Promise<string | undefined> {
  const [one] = await db.select({ id: template.id }).from(template).where(eq(template.experimentId, experimentId)).limit(1);
  return one ? undefined : "it has no template: there is nothing it would say";
}

/** A refusal the DDL gave, as the person reads it; anything else is thrown. */
function refusalOf(error: unknown): string | undefined {
  const e = (error as { cause?: unknown }).cause ?? error;
  const { code, message } = e as { code?: string; message?: string };
  if (code === "23503") return "a draft cites the template on record at this step, so it stays (0072): record a correction, a new variant with --corrects";
  if (code === "23514" && message) return message.replace(/^acquisition\.template: /, "");
  if (code === "23505") return "a template is already on record at this step: --replace withdraws it, while no draft cites it";
  return undefined;
}

export async function recordTemplate(
  db: Database,
  input: TemplateToRecord & { replace: boolean; by: string; trigger: Trigger },
  declaredChannels: ReadonlySet<string>,
): Promise<{ runId: string; templateId: string; replaced: boolean } | { refused: string }> {
  const by = input.by.trim();
  if (!by) return { refused: "who records it is required: a template is what every draft of its step will say" };
  const wrong = checkTemplate(input, declaredChannels);
  if (wrong) return { refused: wrong };
  const [exp] = await db.select({ id: experiment.id }).from(experiment).where(eq(experiment.id, input.experimentId));
  if (!exp) return { refused: "the experiment is not on record" };

  const open = await openRun(db, { processKey: "acquisition.template.record", trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const done = await db.transaction(async (tx) => {
      const at = and(eq(template.experimentId, input.experimentId), eq(template.variant, input.variant), eq(template.step, input.step));
      const [had] = await tx.select({ id: template.id }).from(template).where(at);
      // Without `replace`, one on record at this step is refused by the
      // unique key, never overwritten.
      if (had && input.replace) await tx.delete(template).where(eq(template.id, had.id));
      const [row] = await tx
        .insert(template)
        .values({
          experimentId: input.experimentId,
          variant: input.variant,
          step: input.step,
          channel: input.channel,
          body: input.body,
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.delayDays !== undefined ? { delayDays: input.delayDays } : {}),
          ...(input.corrects !== undefined ? { corrects: input.corrects } : {}),
        })
        .returning({ id: template.id });
      return { templateId: row!.id, replaced: Boolean(had && input.replace) };
    });
    await open.finish({ status: "succeeded" });
    return { runId: open.id, ...done };
  } catch (error) {
    const refused = refusalOf(error);
    await open.finish({ status: "failed", error: (refused ?? (error as Error).message).slice(0, 500) }).catch(() => {});
    if (refused) return { refused };
    throw error;
  }
}
