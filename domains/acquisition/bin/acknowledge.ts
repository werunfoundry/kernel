#!/usr/bin/env node
/**
 * kernel-acknowledge — a person acknowledges what protection cannot reach,
 * by its name, run from an instance's root.
 *
 *   kernel-acknowledge --list
 *   kernel-acknowledge --customer <id> --note "<why it may stay uncovered>" --by <who>
 *   kernel-acknowledge --account <id> --note "<why it may stay unmatched>" --by <who>
 *   kernel-acknowledge --withdraw (--customer <id> | --account <id>) --by <who>
 *
 * A customer none of whose protected rows carries a key is protected by
 * nothing, and stops every run that reads protection (decision 0034). An
 * account the protected set knows by the source's own identifier alone can
 * be matched against no company on record, and stops every enrolment
 * (decision 0068). Each names itself; once acknowledged here, by that name,
 * runs go on and say it each time. One at a time: there is no flag that
 * acknowledges all of them, or any still to come.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the customer's id to be typed again before it does. Each acknowledgement
 * and each withdrawal is its own recorded run, with the person as its actor.
 * No run calls this, and no flag lets one.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "@werunfoundry/core/runtime/connect";

import type { Named } from "../runtime/acknowledge.js";
import { acknowledge, listAcknowledged, withdraw } from "../runtime/acknowledge.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function confirm(id: string, what: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const typed = await rl.question(`${what} ${id}. Type its id again to confirm: `);
    return typed.trim() === id;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("acknowledge: DATABASE_URL is not set.");
    return 1;
  }

  const listing = flag("list");
  const withdrawing = flag("withdraw");
  const customerId = value("customer") ?? "";
  const accountId = value("account") ?? "";
  const by = value("by") ?? "";
  const note = value("note") ?? "";
  const named: Named = customerId ? { customerId } : { accountId };
  const id = customerId || accountId;
  const what = customerId ? "uncovered" : "unmatched";
  if (!listing) {
    if (!customerId === !accountId || !by || (!withdrawing && !note)) {
      console.log("acknowledge: one of --customer or --account, with --by and --note, is required (--note not for --withdraw). Or --list.");
      return 1;
    }
    if (!process.stdin.isTTY) {
      console.log("acknowledge: a person acknowledges, at a terminal. Nothing was written.");
      return 1;
    }
  }

  let connection;
  try {
    connection = await connect(url, root, "acknowledge");
  } catch (error) {
    console.log(`acknowledge: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    if (listing) {
      const standing = await listAcknowledged(connection.db);
      const customers = standing.filter((a) => a.customerId);
      const accounts = standing.filter((a) => a.accountId);
      console.log(`acknowledged as uncovered: ${customers.length}`);
      for (const a of customers) console.log(`  - customer ${a.customerId}, by ${a.acknowledgedBy} on ${a.acknowledgedAt.toISOString()}: ${a.note}`);
      console.log(`acknowledged as unmatched: ${accounts.length}`);
      for (const a of accounts) console.log(`  - account ${a.accountId}, by ${a.acknowledgedBy} on ${a.acknowledgedAt.toISOString()}: ${a.note}`);
      return 0;
    }
    const subject = `${customerId ? "customer" : "account"} ${id}`;
    if (!(await confirm(subject, withdrawing ? "Withdraw the acknowledgement of" : `Acknowledge as ${what}`))) {
      console.log("acknowledge: the id typed does not match. Nothing was written.");
      return 1;
    }
    if (withdrawing) {
      const r = await withdraw(connection.db, { ...named, by });
      console.log(`run: ${r.runId} — ${r.withdrawn ? `withdrawn: ${subject} stops runs again` : `${subject} was not acknowledged; nothing changed`}`);
    } else {
      const r = await acknowledge(connection.db, { ...named, note, by });
      console.log(`run: ${r.runId} — ${r.acknowledged ? `acknowledged: ${subject} no longer stops runs, and every run will say it is ${what}` : `${subject} already stands acknowledged; nothing changed`}`);
    }
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
