#!/usr/bin/env node
/**
 * kernel-experiment — a person records an experiment, then starts it
 * (decisions 0072, 0047), run from an instance's root.
 *
 *   kernel-experiment record --slug <slug> --type <type> --hypothesis <ref> --lane <reviewed|autonomous|reactive> --by <who> [--owner <who>] [--dry-run]
 *   kernel-experiment start --slug <slug> --by <who> [--dry-run]
 *
 * Two acts. **Recorded**, the experiment is in `draft`: nothing is contacted
 * for it. **Started**, it is `running`: the act that authorises contact, which
 * the message gate reads for every approval. A start is refused for an
 * experiment with no template. Nothing here stops one: that is not decided
 * (0072).
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the slug to be typed again before it does. `--dry-run` shows what would be
 * written, and writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";
import { checkExperiment, findExperimentBySlug, recordExperiment, startExperiment, type Lane } from "@werunfoundry/core/runtime/experiment";

import { readyToStart, templatesOf } from "../runtime/template.js";

const [act, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

/** The slug typed again, read as a line the person may have typed ahead. */
async function typedAgain(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  process.stdout.write(prompt);
  const next = await lines.next();
  rl.close();
  return next.done ? undefined : next.value.trim();
}

async function main(): Promise<number> {
  if (act !== "record" && act !== "start") {
    console.log("experiment: record or start — kernel-experiment record --slug … | kernel-experiment start --slug …");
    return 1;
  }
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("experiment: DATABASE_URL is not set.");
    return 1;
  }
  const slug = value("slug")?.trim() ?? "";
  const by = value("by")?.trim() ?? "";
  const dryRun = flag("dry-run");
  if (!slug || !by) {
    console.log("experiment: --slug and --by are required.");
    return 1;
  }
  const given = { slug, type: value("type")?.trim() ?? "", hypothesisRef: value("hypothesis")?.trim() ?? "", lane: (value("lane")?.trim() ?? "") as Lane, ...(value("owner") ? { owner: value("owner")!.trim() } : {}) };
  if (act === "record" && (!given.type || !given.hypothesisRef || !given.lane)) {
    console.log("experiment: record needs --type, --hypothesis and --lane: the lane is said, never assumed.");
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("experiment: a person records and starts an experiment, at a terminal. Nothing was written.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nexperiment: boot refused. Nothing was written.");
    return 1;
  }
  const declaredTypes = new Set(booted.domains.flatMap((d) => d.experimentTypes ?? []));
  let connection;
  try {
    connection = await connect(url, root, "experiment");
  } catch (error) {
    console.log(`experiment: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const db = connection.db;
    const found = await findExperimentBySlug(db, slug);

    if (act === "record") {
      const wrong = checkExperiment(given, declaredTypes) ?? (found ? `an experiment ${slug} is already on record (${found.status})` : undefined);
      if (wrong) {
        console.log(`experiment: ${wrong}. Nothing was written.`);
        return 1;
      }
      console.log(`would record: experiment ${slug}, ${given.type}, lane ${given.lane}, testing ${given.hypothesisRef}${given.owner ? `, owned by ${given.owner}` : ""}`);
      console.log("Recorded, it is in draft: nothing is contacted for it until a person starts it.");
      if (dryRun) {
        console.log("dry run — nothing was written.");
        return 0;
      }
      if ((await typedAgain(`Record experiment ${slug}? Type the slug again to confirm: `)) !== slug) {
        console.log("experiment: what was typed does not match. Nothing was written.");
        return 1;
      }
      const r = await recordExperiment(db, { ...given, by, trigger: "cli" }, declaredTypes);
      if ("refused" in r) {
        console.log(`experiment: ${r.refused}. Nothing was written.`);
        return 1;
      }
      console.log(`run: ${r.runId} — experiment ${slug} recorded, in draft`);
      return 0;
    }

    if (!found) {
      console.log(`experiment: no experiment ${slug} is on record. Nothing was written.`);
      return 1;
    }
    const templates = await templatesOf(db, found.id);
    console.log(`experiment ${slug}: ${found.type}, lane ${found.lane}, ${found.status}; ${templates.length} template${templates.length === 1 ? "" : "s"}`);
    for (const t of templates) console.log(`  - variant ${t.variant}${t.corrects ? ` (corrects ${t.corrects})` : ""}, step ${t.step}, ${t.channel}${t.subject ? `: ${t.subject}` : ""}`);
    const notReady = found.status !== "draft" ? `the experiment is ${found.status}: only one in draft is started` : await readyToStart(db, found.id);
    if (notReady) {
      console.log(`experiment: ${notReady}. Nothing was written.`);
      return 1;
    }
    console.log(`Started, it is running: what its ${found.lane} lane approves may be sent. No command stops it yet (decision 0072).`);
    if (dryRun) {
      console.log("dry run — nothing was written.");
      return 0;
    }
    if ((await typedAgain(`Start experiment ${slug}? Type the slug again to confirm: `)) !== slug) {
      console.log("experiment: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await startExperiment(db, { slug, by, trigger: "cli" }, readyToStart);
    if ("refused" in r) {
      console.log(`experiment: ${r.refused}. Nothing was written.`);
      return 1;
    }
    console.log(`run: ${r.runId} — experiment ${slug} started, running`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
