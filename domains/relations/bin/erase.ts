#!/usr/bin/env node
/**
 * kernel-erase — a person erases someone (decisions 0040, 0049), run from an
 * instance's root.
 *
 *   kernel-erase --person <id> --plan          what each domain would do; changes nothing
 *   kernel-erase --person <id> --by <who>      do it
 *
 * Each enabled domain answers for its own tables — delete, empty, or keep
 * under a stated basis — and the core carries the answers out in one
 * transaction, as a run with the person as actor. For a person, at a
 * terminal: it refuses to erase without one, and asks for the id to be typed
 * again first. The API shows the plan and never erases. A row that is the
 * history of what a run did is anonymised, reached by id and by the person's
 * keys; what the command cannot reach, it says.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";
import { erase, NOT_REACHED, planErasure } from "@werunfoundry/core/runtime/erase";

import { OPT_OUT_AFTER_ERASURE } from "../runtime/record.js";

/** What this does not reach, said on the plan and after the erasure: silence would read as coverage (0049). */
const leaves = () => {
  console.log("Not reached by this command (decision 0049):");
  for (const n of [...NOT_REACHED, OPT_OUT_AFTER_ERASURE]) console.log(`  - ${n}`);
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const personId = value("person") ?? "";
  const by = value("by") ?? "";
  const planOnly = flag("plan");
  if (!personId || (!planOnly && !by)) {
    console.log("erase: --person <id>, and --by <who> unless --plan.");
    return 1;
  }
  if (!planOnly && !process.stdin.isTTY) {
    console.log("erase: a person erases, at a terminal. Nothing was changed.");
    return 1;
  }
  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("erase: DATABASE_URL is not set.");
    return 1;
  }
  const connection = await connect(url, root, "erase");
  try {
    const plan = await planErasure(connection.db, booted.domains, personId);
    for (const s of plan) {
      const keys = s.byKeys ? ` (${s.byKeys} by keys)` : "";
      console.log(`  ${s.domain}.${s.table}: ${s.rows} row${s.rows === 1 ? "" : "s"}${keys} — ${s.do}${s.basis ? ` (${s.basis})` : ""}`);
    }
    leaves();
    if (planOnly) return 0;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`Erase person ${personId}? Type the id again to confirm: `).finally(() => rl.close());
    if (typed.trim() !== personId) {
      console.log("erase: the id did not match. Nothing was changed.");
      return 1;
    }
    const r = await erase(connection.db, booted.domains, { subjectId: personId, by, processKey: "relations.person.erase", trigger: "cli" });
    console.log(`run: ${r.runId} — erased; the person's row was ${r.steps.at(-1)?.outcome ?? "not declared"}.`);
    leaves();
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
