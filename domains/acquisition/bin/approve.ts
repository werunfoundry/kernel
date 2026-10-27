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
 * awaiting review and shows the next.
 *
 * `edit` corrects it first (decision 0072): the draft opens in the person's
 * editor (`VISUAL`, or `EDITOR`), the corrected text is shown whole, and the
 * address is typed again to approve that text. A correction is marked on
 * the draft, and the experiment's streak goes back to zero. It is the only
 * recourse for a person drafted from a template since corrected. There is no flag that approves several,
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

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const BODY_LINE = "---- body: edit below this line ----";

/**
 * The draft's text, corrected in the person's editor, or why it was not.
 * A step without a subject stays without one: the provider's step decides it.
 */
function correct(d: AwaitingDraft): { subject: string | null; body: string } | { not: string } {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!editor) return { not: "no editor is set: set VISUAL or EDITOR to correct a draft" };
  const dir = mkdtempSync(join(tmpdir(), "kernel-approve-"));
  const file = join(dir, "draft.txt");
  try {
    writeFileSync(file, `${d.subject !== null ? `subject: ${d.subject}\n` : ""}${BODY_LINE}\n${d.body ?? ""}\n`);
    // The editor takes the terminal while it runs, then gives it back.
    const ran = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (ran.status !== 0) return { not: `the editor exited ${ran.status ?? ran.signal}` };
    const text = readFileSync(file, "utf8");
    const at = text.indexOf(`${BODY_LINE}\n`);
    if (at < 0) return { not: `the line "${BODY_LINE}" is gone, so the body cannot be told from the subject` };
    const head = text.slice(0, at).replace(/\n$/, "");
    const body = text.slice(at + BODY_LINE.length + 1).replace(/\n$/, "");
    if (!body.trim()) return { not: "the corrected body is empty" };
    if (d.subject === null) return head.trim() ? { not: "this step is sent without a subject, and stays without one" } : { subject: null, body };
    if (!head.startsWith("subject: ") || head.includes("\n") || !head.slice(9).trim()) return { not: 'the subject is one line, "subject: …", and not empty' };
    return { subject: head.slice(9), body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
        process.stdout.write(`Approving lets this text go to ${d.label} when they are enrolled; it sends nothing now. Type the address again to approve, "edit" to correct it first, or press Enter to leave it: `);
        let next = await lines.next();
        // Input that ends — a closed terminal — approves nothing more.
        let typed: string | null = next.done ? null : next.value;
        let corrected: { subject: string | null; body: string } | undefined;
        if (typed?.trim() === "edit") {
          rl.pause();
          const c = correct(d);
          rl.resume();
          if ("not" in c) {
            console.log(`not corrected: ${c.not}. Left awaiting review.`);
            continue;
          }
          corrected = c;
          console.log(show({ ...d, subject: c.subject, body: c.body }, i + 1, drafts.length).replace("---- body, as it will be sent ----", "---- body, corrected, as it will be sent ----"));
          process.stdout.write(`A correction is marked on the draft, and the experiment's streak goes back to zero. Type the address again to approve the corrected text, or press Enter to leave it as it was: `);
          next = await lines.next();
          typed = next.done ? null : next.value;
        }
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
        const r = await approveAsPerson(connection.db, { draftId: d.id, by, trigger: "cli", ...(corrected ? { corrected } : {}) });
        if (r.decided.ok) {
          approved++;
          console.log(`run: ${r.runId} — approved by ${by}${corrected ? ", corrected" : ""}`);
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
