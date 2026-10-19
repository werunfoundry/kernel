#!/usr/bin/env node
/**
 * kernel-relationship — a person declares a company's relationship (decisions
 * 0036, 0047), run from an instance's root.
 *
 *   kernel-relationship --company <domain|id> --status customer|former_customer|none --at <when> --by <who> [--why "<why>"] [--dry-run]
 *
 * `--at` is when it became true: a date (that day, 00:00 UTC) or a time with
 * its zone. It is never assumed.
 *
 * On a company only: being a customer belongs to a person's affiliation to a
 * company, which the record does not have, and the company is the nearest
 * subject it does (0047). Here, in the shared domain, and never in the one
 * that prospects — which is not the same as being written where the payment
 * is observed: nothing here observes one.
 *
 * A declaration protects nobody and releases nobody: protection reads its
 * own source (0041). It is an operator's annotation, read by whoever reads
 * relationships.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the company's domain to be typed again before it does. `--dry-run` shows
 * what would be written, and writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "@werunfoundry/core/runtime/connect";

import { relationship } from "../db/schema.js";
import { nameCompany } from "../runtime/record.js";
import type { RelationshipStatus } from "../runtime/relationship.js";
import { checkDeclaration, declareRelationship, planDeclaration, readMoment, readRelationship } from "../runtime/relationship.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

const statuses: readonly string[] = relationship.status.enumValues;

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("relationship: DATABASE_URL is not set.");
    return 1;
  }

  if (flag("person")) {
    console.log("relationship: a relationship is declared on a company, not on a person alone (decision 0047). Nothing was written.");
    return 1;
  }
  const typed = value("company") ?? "";
  const status = value("status") ?? "";
  const by = value("by") ?? "";
  const when = value("at") ?? "";
  const why = value("why");
  const dryRun = flag("dry-run");
  if (!typed || !status || !when || !by) {
    console.log("relationship: --company, --status, --at and --by are required.");
    return 1;
  }
  if (!statuses.includes(status)) {
    console.log(`relationship: --status is one of ${statuses.join(", ")}.`);
    return 1;
  }
  const moment = readMoment(when);
  if ("refused" in moment) {
    console.log(`relationship: --at ${moment.refused}.`);
    return 1;
  }
  const refused = checkDeclaration({ at: moment.at, by });
  if (refused) {
    console.log(`relationship: ${refused}.`);
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("relationship: a person declares, at a terminal. Nothing was written.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "relationship");
  } catch (error) {
    console.log(`relationship: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const named = await nameCompany(connection.db, typed);
    if ("refused" in named) {
      console.log(`relationship: ${named.refused}. Nothing was written.`);
      return 1;
    }
    const current = await readRelationship(connection.db, { companyId: named.id });
    console.log(current ? `${named.label}: ${current.status} since ${current.at.toISOString()}, declared by ${current.declaredBy}` : `${named.label}: no relationship declared`);
    const plan = planDeclaration(current && { state: current.status, at: current.at }, { state: status, at: moment.at });
    if ("already" in plan) {
      console.log("relationship: that is already the declaration on record. Nothing was written.");
      return 0;
    }
    if ("refused" in plan) {
      console.log(`relationship: ${plan.refused}. Nothing was written.`);
      return 1;
    }
    const what = `${named.label} ${status} from ${moment.at.toISOString()}${plan.current ? "" : " — dated before the current one, so history, not the current relationship"}`;
    if (dryRun) {
      console.log(`dry run — would declare ${what}. Nothing was written.`);
      return 0;
    }
    console.log(
      "A declaration is never rewritten. A wrong status is corrected by declaring the right one, at or after this moment;" +
        " a wrong company, by declaring none on it. A wrong moment cannot be corrected (decision 0047).",
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const again = await rl.question(`Declare ${what}. Type the domain again to confirm: `).finally(() => rl.close());
    if (again.trim() !== named.label) {
      console.log("relationship: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await declareRelationship(connection.db, {
      subject: { companyId: named.id },
      status: status as RelationshipStatus,
      at: moment.at,
      ...(why ? { reason: why } : {}),
      by,
    });
    console.log(`run: ${r.runId} — ${r.declared ? `declared: ${what}` : "the same declaration was written meanwhile; nothing changed"}`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
