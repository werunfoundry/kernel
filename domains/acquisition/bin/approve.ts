#!/usr/bin/env node
/**
 * kernel-approve — a person approves the drafts of an experiment, one at a
 * time (decisions 0027, 0047), run from an instance's root.
 *
 *   kernel-approve --experiment <slug> --by <who> [--dry-run]
 *
 * Each draft awaiting review is shown whole — who it goes to, its step, its
 * subject and its body as they will be sent — and approved only when the
 * address it goes to is typed again. Enter, or anything else, leaves it
 * awaiting review and shows the next. There is no flag that approves several,
 * or one without its text being shown: an approval is the one guarantee
 * between a draft and a message that leaves, and a function call cannot give
 * it (`runtime/approve`).
 *
 * Approving sends nothing: an approved draft is carried by the enrolment from
 * the same list (`kernel-enrol --list`), through the message gate.
 *
 * For a person, at a terminal: it refuses to write without one. `--dry-run`
 * shows what awaits review, and writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "@werunfoundry/core/runtime/connect";
import { findExperiment } from "@werunfoundry/core/runtime/decision";

import type { AwaitingDraft } from "../runtime/approve.js";
import { approveAsPerson, awaitingReview } from "../runtime/approve.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

/** A draft as it is read before it is approved: nothing elided. */
function show(d: AwaitingDraft, n: number, of: number): string {
  return [
    "",
    `draft ${n} of ${of} — to ${d.label ?? "a person whose keys were erased"}${d.fullName ? ` (${d.fullName})` : ""}, step ${d.step}${d.channel ? `, ${d.channel}` : ""}`,
    `subject: ${d.subject ?? "(none: the step is sent without one)"}`,
    "---- body, as it will be sent ----",
    d.body ?? "",
    "---- end of body ----",
  ].join("\n");
}

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("approve: DATABASE_URL is not set.");
    return 1;
  }

  const slug = value("experiment")?.trim() ?? "";
  const by = value("by")?.trim() ?? "";
  const dryRun = flag("dry-run");
  if (!slug || !by) {
    console.log("approve: --experiment and --by are required.");
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("approve: a person approves, at a terminal. Nothing was written.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "approve");
  } catch (error) {
    console.log(`approve: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const experiment = await findExperiment(connection.db, slug);
    if (!experiment) {
      console.log(`approve: no experiment "${slug}" is on record. Nothing was written.`);
      return 1;
    }
    const drafts = await awaitingReview(connection.db, experiment.id);
    console.log(`experiment ${experiment.slug} — ${experiment.status}; ${drafts.length} draft${drafts.length === 1 ? "" : "s"} awaiting review`);
    if (drafts.length === 0) return 0;
    if (dryRun) {
      drafts.forEach((d, i) => console.log(show(d, i + 1, drafts.length)));
      console.log("\ndry run — nothing was approved. Nothing was written.");
      return 0;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Read as a stream of lines, so a line typed while an approval is written
    // is kept for the next draft rather than lost.
    const lines = rl[Symbol.asyncIterator]();
    let refused = 0;
    let approved = 0;
    try {
      for (const [i, d] of drafts.entries()) {
        console.log(show(d, i + 1, drafts.length));
        if (!d.label) {
          console.log("Nothing to type again for a person whose keys were erased: left awaiting review.");
          continue;
        }
        process.stdout.write(`Approving lets this text go to ${d.label} when they are enrolled; it sends nothing now. Type the address again to approve, or press Enter to leave it: `);
        const next = await lines.next();
        // Input that ends — a closed terminal — approves nothing more.
        const typed: string | null = next.done ? null : next.value;
        if (typed === null) {
          console.log("\napprove: the input ended. Nothing more was approved.");
          break;
        }
        if (typed.trim() === "") {
          console.log("left awaiting review.");
          continue;
        }
        if (typed.trim() !== d.label) {
          console.log("what was typed does not match: left awaiting review.");
          continue;
        }
        const r = await approveAsPerson(connection.db, { draftId: d.id, by, trigger: "cli" });
        if (r.decided.ok) {
          approved++;
          console.log(`run: ${r.runId} — approved by ${by}`);
        } else {
          refused++;
          console.log(`run: ${r.runId} — refused: ${r.decided.refused}`);
        }
      }
    } finally {
      rl.close();
    }
    console.log(`approve: ${approved} approved, ${drafts.length - approved - refused} left awaiting review${refused ? `, ${refused} refused` : ""}.`);
    return refused > 0 ? 1 : 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
