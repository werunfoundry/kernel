#!/usr/bin/env node
/**
 * kernel-attest-stop — a person attests that an enrolment can no longer send
 * (decision 0056), run from an instance's root, when an erasure was refused
 * in one of the four cases retrying cannot fix.
 *
 *   kernel-attest-stop --enrolment <id> --stopped-by-hand "<how>" --by <who>
 *   kernel-attest-stop --enrolment <id> --account-closed "<what you know>" --by <who>
 *
 * Two facts, two forms. Where the provider still runs, the person stopped
 * this person in this sequence by hand, and says how. Where the account is
 * closed, nothing can send, and they say what they know of it. Either names
 * one enrolment, and is recorded as a person's act under their name — never
 * as what a provider read back. Then the erasure is run again.
 *
 * It refuses where a suspension can still be tried: there, running the
 * erasure again is the remedy. For a person, at a terminal: it refuses
 * without one, and asks for the enrolment's id to be typed again first.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import type { Attested } from "../runtime/attest.js";
import { attestStop } from "../runtime/attest.js";

const args = process.argv.slice(2);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const enrolmentId = value("enrolment") ?? "";
  const by = value("by") ?? "";
  const how = value("stopped-by-hand");
  const said = value("account-closed");
  if (!enrolmentId || !by || (how === undefined) === (said === undefined)) {
    console.log('attest-stop: --enrolment, --by, and one of --stopped-by-hand "<how>" or --account-closed "<what you know>".');
    return 1;
  }
  if (!process.stdin.isTTY) {
    console.log("attest-stop: a person attests, at a terminal. Nothing was recorded.");
    return 1;
  }
  const attested: Attested = how !== undefined ? { kind: "stopped_by_hand", how } : { kind: "account_closed", said: said! };

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("attest-stop: DATABASE_URL is not set.");
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(`Attest, under the name "${by}", that enrolment ${enrolmentId} can no longer send? Type its id again to confirm: `).finally(() => rl.close());
  if (typed.trim() !== enrolmentId) {
    console.log("attest-stop: the id did not match. Nothing was recorded.");
    return 1;
  }

  const connection = await connect(url, root, "attest-stop");
  try {
    const r = await attestStop({ db: connection.db, registry: booted.registry }, { enrolmentId, by, attested, trigger: "cli" });
    if ("refused" in r) {
      console.log(`attest-stop: refused — ${r.refused}. Nothing was recorded.`);
      return 1;
    }
    console.log(`run: ${r.runId} — attested (${r.case}); recorded as a person's word, not as a provider's read-back. Run the erasure again.`);
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
