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
 *
 * For a person whose opt-out is not on record, it asks whether the request
 * includes not being contacted (decision 0052). Only `yes` or `no` is an
 * answer; anything else, an empty line or a closed input, erases nothing.
 * No flag answers it. On `yes`, the objection outlives the person as one
 * fingerprint per key in the register (0062).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { eq } from "drizzle-orm";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";
import { erase, ErasureRefused, NOT_REACHED, planBeforeErasure, planDuringErasure, planErasure } from "@werunfoundry/core/runtime/erase";

import { person } from "../db/schema.js";
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
  // A lost secret does not stop an erasure, and is said (0063).
  for (const i of booted.issues) console.log(`  ! ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("erase: DATABASE_URL is not set.");
    return 1;
  }
  const connection = await connect(url, root, "erase");
  const reach = { registry: booted.registry, root, fingerprints: booted.fingerprints };
  try {
    // First what each domain does elsewhere before the kernel forgets anyone
    // (0056), as dry runs: a refusal here is the refusal the erasure would meet.
    for (const { domain, result } of await planBeforeErasure(connection.db, booted.domains, personId, reach)) {
      for (const a of result.acts) console.log(`  before erasure, ${domain}: ${a.rows} ${a.what}${a.through ? `, through the ${a.through}` : ""}`);
      for (const r of result.refused) {
        console.log(`  before erasure, ${domain}: would be refused — the ${r.contract} adapter bound as "${r.binding}": ${r.answered}`);
        console.log(`      ${r.retry ? "running the erasure again is the remedy" : `retrying will not fix this: ${r.remedy ?? "nothing the kernel can do will"}`}`);
      }
    }
    // Then what each domain writes inside the transaction (0062), under
    // either answer to the question: it has not been asked yet.
    for (const { domain, result } of await planDuringErasure(connection.db, booted.domains, personId, reach)) {
      for (const a of result.acts) console.log(`  during erasure, ${domain}: ${a.rows} ${a.what}`);
    }
    const plan = await planErasure(connection.db, booted.domains, personId);
    for (const s of plan) {
      const keys = s.byKeys ? ` (${s.byKeys} by keys)` : "";
      console.log(`  ${s.domain}.${s.table}: ${s.rows} row${s.rows === 1 ? "" : "s"}${keys} — ${s.do}${s.basis ? ` (${s.basis})` : ""}`);
    }
    leaves();
    if (planOnly) return 0;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Lines are buffered, so that one typed ahead of its question is not lost;
    // a closed input answers nothing: it is not a confirmation, nor a no.
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (question: string): Promise<string | undefined> => {
      rl.setPrompt(question);
      rl.prompt();
      const next = await lines.next();
      return next.done ? undefined : next.value;
    };
    let objects: boolean;
    try {
      const typed = await ask(`Erase person ${personId}? Type the id again to confirm: `);
      if (typed?.trim() !== personId) {
        console.log("erase: the id did not match. Nothing was changed.");
        return 1;
      }
      // Whoever objected keeps their objection; for anyone else, the request says (0052).
      const [who] = await connection.db.select({ optedOutAt: person.optedOutAt }).from(person).where(eq(person.id, personId));
      if (!who || who.optedOutAt !== null) objects = who !== undefined;
      else {
        const said = (await ask("Does the request include not being contacted? Type yes or no: "))?.trim().toLowerCase();
        if (said !== "yes" && said !== "no") {
          console.log("erase: only yes or no answers whether the request includes not being contacted (decision 0052). Nothing was changed.");
          return 1;
        }
        objects = said === "yes";
      }
    } finally {
      rl.close();
    }
    let r;
    try {
      r = await erase(connection.db, booted.domains, { subjectId: personId, by, processKey: "relations.person.erase", trigger: "cli", objects }, reach);
    } catch (error) {
      if (!(error instanceof ErasureRefused)) throw error;
      console.log(error.message);
      return 1;
    }
    for (const b of r.before) for (const a of b.acts) console.log(`  before erasure, ${b.domain}: ${a.rows} ${a.what}${a.through ? `, through the ${a.through}` : ""}`);
    for (const d of r.during) for (const a of d.acts) console.log(`  during erasure, ${d.domain}: ${a.rows} ${a.what}`);
    console.log(`run: ${r.runId} — erased; the person's row was ${r.steps.at(-1)?.outcome ?? "not declared"}.`);
    leaves();
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
