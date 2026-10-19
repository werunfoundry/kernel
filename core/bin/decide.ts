#!/usr/bin/env node
/**
 * kernel-decide — a person records a decision on an experiment (decisions
 * 0039, 0047), run from an instance's root.
 *
 *   kernel-decide --experiment <slug> --conclusion "<what was concluded>" (--readings <file.json> | --no-readings) --by <who> [--why "<why>"] [--dry-run]
 *
 * The readings are the figures the person read, as a JSON list of
 * `{ metric, value, readAt }`, kept as given; `--no-readings` says nothing was
 * read. Nothing here reads a metric or computes a conclusion.
 *
 * Each run of this command is one decision: concluding again is a second
 * act, not a replay (0047). It shows the decisions already on the experiment
 * first. A decision is never edited: a mistaken one is corrected by another
 * that says so.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the experiment's slug to be typed again before it does. `--dry-run` shows
 * what would be written, and writes nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "../runtime/connect.js";
import { checkReadings, findExperiment, listDecisions, recordDecision } from "../runtime/decision.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("decide: DATABASE_URL is not set.");
    return 1;
  }

  const slug = value("experiment")?.trim() ?? "";
  const conclusion = value("conclusion")?.trim() ?? "";
  const by = value("by")?.trim() ?? "";
  const why = value("why");
  const readingsFile = value("readings");
  const noReadings = flag("no-readings");
  const dryRun = flag("dry-run");
  if (!slug || !conclusion || !by) {
    console.log("decide: --experiment, --conclusion and --by are required.");
    return 1;
  }
  if (!readingsFile === !noReadings) {
    console.log("decide: one of --readings <file.json> or --no-readings is required: an empty set of readings is said, not assumed.");
    return 1;
  }
  let given: unknown = [];
  if (readingsFile) {
    try {
      given = JSON.parse(readFileSync(resolve(root, readingsFile), "utf8"));
    } catch (error) {
      console.log(`decide: cannot read ${readingsFile} as JSON — ${(error as Error).message}`);
      return 1;
    }
  }
  const checked = checkReadings(given);
  if ("refused" in checked) {
    console.log(`decide: ${checked.refused}. Nothing was written.`);
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("decide: a person decides, at a terminal. Nothing was written.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "decide");
  } catch (error) {
    console.log(`decide: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const experiment = await findExperiment(connection.db, slug);
    if (!experiment) {
      console.log(`decide: no experiment ${slug} is on record. Nothing was written.`);
      return 1;
    }
    const earlier = await listDecisions(connection.db, experiment.id);
    console.log(`experiment ${slug} (${experiment.status}): ${earlier.length} decision${earlier.length === 1 ? "" : "s"} already recorded`);
    for (const d of earlier) console.log(`  - ${d.decidedAt.toISOString()}, by ${d.decidedBy}: ${d.conclusion}`);
    console.log(`would record: "${conclusion}", by ${by}, on ${checked.readings.length} reading${checked.readings.length === 1 ? "" : "s"}`);
    for (const r of checked.readings) console.log(`  - ${r.metric} = ${r.value ?? "none"}, read ${r.readAt}`);
    if (dryRun) {
      console.log("dry run — nothing was written.");
      return 0;
    }
    console.log("A decision is never edited, and recording it again is a second decision (decision 0047).");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const again = await rl.question(`Record this decision on ${slug}? Type the slug again to confirm: `).finally(() => rl.close());
    if (again.trim() !== slug) {
      console.log("decide: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await recordDecision(connection.db, { experimentId: experiment.id, conclusion, ...(why ? { rationale: why } : {}), readings: checked.readings, by, trigger: "cli" });
    console.log(`run: ${r.runId} — decision ${r.decisionId} recorded on ${slug}`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
