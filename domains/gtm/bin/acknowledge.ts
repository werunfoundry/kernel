#!/usr/bin/env node
/**
 * kernel-acknowledge — a person acknowledges a protected customer as
 * uncovered (decision 0034), run from an instance's root.
 *
 *   kernel-acknowledge --list
 *   kernel-acknowledge --customer <id> --note "<why it may stay uncovered>" --by <who>
 *   kernel-acknowledge --withdraw --customer <id> --by <who>
 *
 * A customer none of whose protected rows carries a key is protected by
 * nothing, and stops every run that reads protection, naming itself. Once
 * acknowledged here, runs go on, and say it is uncovered each time.
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

import { acknowledgeUncovered, listAcknowledged, withdrawAcknowledgement } from "../runtime/acknowledge.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function confirm(customerId: string, what: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const typed = await rl.question(`${what} customer ${customerId}. Type its id again to confirm: `);
    return typed.trim() === customerId;
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
  const by = value("by") ?? "";
  const note = value("note") ?? "";
  if (!listing) {
    if (!customerId || !by || (!withdrawing && !note)) {
      console.log('acknowledge: --customer, --by and --note are required (--note not for --withdraw). Or --list.');
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
      console.log(`acknowledged as uncovered: ${standing.length}`);
      for (const a of standing) console.log(`  - ${a.customerId}, by ${a.acknowledgedBy} on ${a.acknowledgedAt.toISOString()}: ${a.note}`);
      return 0;
    }
    if (!(await confirm(customerId, withdrawing ? "Withdraw the acknowledgement of" : "Acknowledge as uncovered"))) {
      console.log("acknowledge: the id typed does not match. Nothing was written.");
      return 1;
    }
    if (withdrawing) {
      const r = await withdrawAcknowledgement(connection.db, { customerId, by });
      console.log(`run: ${r.runId} — ${r.withdrawn ? `withdrawn: ${customerId} stops runs again` : `${customerId} was not acknowledged; nothing changed`}`);
    } else {
      const r = await acknowledgeUncovered(connection.db, { customerId, note, by });
      console.log(`run: ${r.runId} — ${r.acknowledged ? `acknowledged: ${customerId} no longer stops runs, and every run will say it is uncovered` : `${customerId} already stands acknowledged; nothing changed`}`);
    }
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
