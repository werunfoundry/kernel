#!/usr/bin/env node
/**
 * kernel-template — a person records a template: one step of one variant of
 * an experiment (decisions 0072, 0047), run from an instance's root.
 *
 *   kernel-template --experiment <slug> --variant <v> --step <n> --channel <channel> --body <file> --by <who>
 *                   [--subject "<subject>"] [--delay-days <n>] [--corrects <arm>] [--replace] [--dry-run]
 *
 * The body is read from a file, as written. The whole text is shown before
 * anything is written: it is what every draft of this step will say.
 *
 * A template is never rewritten. `--replace` withdraws the one on record at
 * this step and records this one instead, while no draft cites it. Once one
 * does, a correction is a new variant, `--corrects <arm>`: it carries every
 * step, and reaches only the people not drafted yet.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the experiment's slug to be typed again before it does. `--dry-run` shows
 * what would be written, and writes nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";
import { findExperimentBySlug } from "@werunfoundry/core/runtime/experiment";

import { checkTemplate, recordTemplate, templatesOf, type TemplateToRecord } from "../runtime/template.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("template: DATABASE_URL is not set.");
    return 1;
  }
  const slug = value("experiment")?.trim() ?? "";
  const by = value("by")?.trim() ?? "";
  const bodyFile = value("body");
  const dryRun = flag("dry-run");
  const replace = flag("replace");
  if (!slug || !by || !bodyFile || !value("variant") || !value("step") || !value("channel")) {
    console.log("template: --experiment, --variant, --step, --channel, --body <file> and --by are required.");
    return 1;
  }
  let body: string;
  try {
    body = readFileSync(resolve(root, bodyFile), "utf8").replace(/\n$/, "");
  } catch (error) {
    console.log(`template: cannot read ${bodyFile} — ${(error as Error).message}`);
    return 1;
  }
  const delay = value("delay-days");
  const given = {
    variant: value("variant")!.trim(),
    step: Number(value("step")),
    channel: value("channel")!.trim(),
    body,
    ...(value("subject") !== undefined ? { subject: value("subject")! } : {}),
    ...(delay !== undefined ? { delayDays: Number(delay) } : {}),
    ...(value("corrects") !== undefined ? { corrects: value("corrects")!.trim() } : {}),
  };
  if (!dryRun && !process.stdin.isTTY) {
    console.log("template: a person records a template, at a terminal. Nothing was written.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\ntemplate: boot refused. Nothing was written.");
    return 1;
  }
  const channels = new Set(booted.domains.flatMap((d) => d.channels ?? []));
  let connection;
  try {
    connection = await connect(url, root, "template");
  } catch (error) {
    console.log(`template: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const db = connection.db;
    const found = await findExperimentBySlug(db, slug);
    if (!found) {
      console.log(`template: no experiment ${slug} is on record. Nothing was written.`);
      return 1;
    }
    const input: TemplateToRecord = { experimentId: found.id, ...given };
    const wrong = checkTemplate(input, channels);
    if (wrong) {
      console.log(`template: ${wrong}. Nothing was written.`);
      return 1;
    }
    const onRecord = (await templatesOf(db, found.id)).find((t) => t.variant === given.variant && t.step === given.step);
    console.log(`experiment ${slug}: ${found.status}, lane ${found.lane}`);
    if (onRecord) {
      console.log(`on record at variant ${given.variant}, step ${given.step}${replace ? ", to be withdrawn" : ""}:`);
      if (onRecord.subject) console.log(`subject: ${onRecord.subject}`);
      console.log(`---- body ----\n${onRecord.body}\n---- end of body ----`);
      if (!replace) {
        console.log("template: a template is already on record at this step, and is never rewritten: --replace withdraws it, while no draft cites it. Nothing was written.");
        return 1;
      }
    }
    console.log(`would record: variant ${given.variant}${given.corrects ? ` (a correction of ${given.corrects}: not an arm)` : ""}, step ${given.step}, ${given.channel}${given.delayDays !== undefined ? `, ${given.delayDays} days after the step before` : ""}`);
    if (given.subject !== undefined) console.log(`subject: ${given.subject}`);
    console.log(`---- body, as every draft of this step will start ----\n${body}\n---- end of body ----`);
    if (dryRun) {
      console.log("dry run — nothing was written.");
      return 0;
    }
    console.log("A template is never rewritten: once a draft cites it, a correction is a new variant.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = rl[Symbol.asyncIterator]();
    process.stdout.write(`Record this template on ${slug}? Type the slug again to confirm: `);
    const next = await lines.next();
    rl.close();
    if (next.done || next.value.trim() !== slug) {
      console.log("template: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await recordTemplate(db, { ...input, replace, by, trigger: "cli" }, channels);
    if ("refused" in r) {
      console.log(`template: ${r.refused}. Nothing was written.`);
      return 1;
    }
    console.log(`run: ${r.runId} — template ${r.templateId} recorded${r.replaced ? ", the one before it withdrawn" : ""}`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
