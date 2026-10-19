#!/usr/bin/env node
/**
 * kernel-stage — a person declares a stage of the addressing motion
 * (decisions 0036, 0047), run from an instance's root.
 *
 *   kernel-stage (--person <address|id> | --company <domain|id>) --stage targeted|engaged|opportunity --at <when> --by <who> [--why "<why>"] [--dry-run]
 *
 * `--at` is when it became true: a date (that day, 00:00 UTC) or a time with
 * its zone. It is never assumed.
 *
 * A stage has no neutral value and a declaration is never rewritten, so a
 * stage declared on the wrong subject or at the wrong moment cannot be
 * corrected (0047). The command says so before it asks for confirmation.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the subject's key to be typed again before it does. `--dry-run` shows what
 * would be written, and writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "@werunfoundry/core/runtime/connect";
import { nameCompany, namePerson } from "@werunfoundry/relations/runtime/record";
import { checkDeclaration, planDeclaration, readMoment } from "@werunfoundry/relations/runtime/relationship";

import { personState } from "../db/schema.js";
import type { Stage, Subject } from "../runtime/stage.js";
import { declareStage, readStage } from "../runtime/stage.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

const stages: readonly string[] = personState.stage.enumValues;

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("stage: DATABASE_URL is not set.");
    return 1;
  }

  const personKey = value("person");
  const companyKey = value("company");
  const stage = value("stage") ?? "";
  const by = value("by") ?? "";
  const when = value("at") ?? "";
  const why = value("why");
  const dryRun = flag("dry-run");
  if (!personKey === !companyKey || !stage || !when || !by) {
    console.log("stage: one of --person or --company, and --stage, --at and --by, are required.");
    return 1;
  }
  if (!stages.includes(stage)) {
    console.log(`stage: --stage is one of ${stages.join(", ")}.`);
    return 1;
  }
  const moment = readMoment(when);
  if ("refused" in moment) {
    console.log(`stage: --at ${moment.refused}.`);
    return 1;
  }
  const refused = checkDeclaration({ at: moment.at, by });
  if (refused) {
    console.log(`stage: ${refused}.`);
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("stage: a person declares, at a terminal. Nothing was written.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "stage");
  } catch (error) {
    console.log(`stage: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const named = personKey ? await namePerson(connection.db, personKey) : await nameCompany(connection.db, companyKey!);
    if ("refused" in named) {
      console.log(`stage: ${named.refused}. Nothing was written.`);
      return 1;
    }
    const subject: Subject = personKey ? { personId: named.id } : { companyId: named.id };
    const current = await readStage(connection.db, subject);
    console.log(current ? `${named.label}: ${current.stage} since ${current.at.toISOString()}, declared by ${current.declaredBy}` : `${named.label}: no stage declared`);
    const plan = planDeclaration(current && { state: current.stage, at: current.at }, { state: stage, at: moment.at });
    if ("already" in plan) {
      console.log("stage: that is already the declaration on record. Nothing was written.");
      return 0;
    }
    if ("refused" in plan) {
      console.log(`stage: ${plan.refused}. Nothing was written.`);
      return 1;
    }
    const what = `${named.label} ${stage} from ${moment.at.toISOString()}${plan.current ? "" : " — dated before the current one, so history, not the current stage"}`;
    if (dryRun) {
      console.log(`dry run — would declare ${what}. Nothing was written.`);
      return 0;
    }
    console.log(
      "A declaration is never rewritten. A wrong stage is corrected by declaring the right one, at or after this moment." +
        " A stage on the wrong subject, or at the wrong moment, cannot be corrected: a stage has no neutral value (decision 0047).",
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const again = await rl.question(`Declare ${what}. Type the ${personKey ? "address" : "domain"} again to confirm: `).finally(() => rl.close());
    if (again.trim() !== named.label) {
      console.log("stage: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await declareStage(connection.db, { subject, stage: stage as Stage, at: moment.at, ...(why ? { reason: why } : {}), by });
    console.log(`run: ${r.runId} — ${r.declared ? `declared: ${what}` : "the same declaration is already on record, in the history or written meanwhile; nothing changed"}`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
