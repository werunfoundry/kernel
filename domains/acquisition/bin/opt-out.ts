#!/usr/bin/env node
/**
 * kernel-opt-out — a person records that someone asked to stop, read in a
 * reply (decisions 0065 §3, 0047), run from an instance's root.
 *
 *   kernel-opt-out --person <address|id> --at <when> --by <who> [--dry-run]
 *
 * `--at` is when they asked: the date or time of their reply, never assumed.
 *
 * The person reads the reply where it arrived, and judges it: the provider
 * does not class a reply asking to stop, and neither the adapter nor the
 * kernel reads free text (0065). This records that judgement on the
 * person's record, where the one reader finds it (0055), then stops every
 * enrolment still running for someone who opted out, at its sequencer.
 *
 * An opt-out is never cleared, here or anywhere: recording one on the wrong
 * person cannot be undone by this command. It says so before it asks.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the address to be typed again before it does. `--dry-run` shows the
 * person, whether their opt-out is already on record, and what is running
 * for them, and writes nothing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { and, eq, inArray } from "drizzle-orm";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";
import { person } from "@werunfoundry/relations/db/schema";
import { namePerson } from "@werunfoundry/relations/runtime/record";
import { readMoment } from "@werunfoundry/relations/runtime/relationship";

import { enrolment } from "../db/schema.js";
import { recordOptOutRead } from "../runtime/opt-out.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("opt-out: DATABASE_URL is not set.");
    return 1;
  }

  const key = value("person") ?? "";
  const when = value("at") ?? "";
  const by = value("by")?.trim() ?? "";
  const dryRun = flag("dry-run");
  if (!key || !when || !by) {
    console.log("opt-out: --person, --at and --by are required.");
    return 1;
  }
  const moment = readMoment(when);
  if ("refused" in moment) {
    console.log(`opt-out: --at ${moment.refused}.`);
    return 1;
  }
  if (moment.at.getTime() > Date.now()) {
    console.log("opt-out: --at is when they asked, and that is not in the future.");
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("opt-out: a person records it, at a terminal. Nothing was written.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nopt-out: boot refused. Nothing was written.");
    return 1;
  }
  let connection;
  try {
    connection = await connect(url, root, "opt-out");
  } catch (error) {
    console.log(`opt-out: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const named = await namePerson(connection.db, key);
    if ("refused" in named) {
      console.log(`opt-out: ${named.refused}. Nothing was written.`);
      return 1;
    }
    const [row] = await connection.db.select({ optedOutAt: person.optedOutAt }).from(person).where(eq(person.id, named.id));
    const running = await connection.db
      .select({ sequenceKey: enrolment.sequenceKey, state: enrolment.state })
      .from(enrolment)
      .where(and(eq(enrolment.personId, named.id), inArray(enrolment.state, ["enrolled", "pending"])));
    console.log(`${named.label}: ${row?.optedOutAt ? `opted out since ${row.optedOutAt.toISOString()}` : "no opt-out on record"}`);
    console.log(running.length ? `running for them: ${running.map((r) => `${r.sequenceKey} (${r.state})`).join(", ")}` : "nothing running for them");
    if (dryRun) {
      console.log(`dry run — would record that ${named.label} asked to stop at ${moment.at.toISOString()}, then stop at its sequencer what runs for anyone who opted out. Nothing was written.`);
      return 0;
    }
    console.log("An opt-out is never cleared. Recorded on the wrong person, it cannot be undone here.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = rl[Symbol.asyncIterator]();
    process.stdout.write(`Record that ${named.label} asked to stop at ${moment.at.toISOString()}. Type the address again to confirm: `);
    const next = await lines.next();
    rl.close();
    if (next.done || next.value.trim().toLowerCase() !== named.label.toLowerCase()) {
      console.log("opt-out: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await recordOptOutRead(
      { db: connection.db, registry: booted.registry, eventTypes: new Set(booted.domains.flatMap((d) => d.eventTypes ?? [])) },
      { personId: named.id, at: moment.at, by, trigger: "cli" },
    );
    console.log(`run: ${r.runId} — ${r.recorded ? "recorded" : "already on record: the first moment stands"}`);
    console.log(`  stopped at the provider: ${r.stopped.suspended} suspended, ${r.stopped.byAddress} stopped by address only (left pending, 0060), ${r.stopped.notHeld} no longer held there`);
    if (r.stopped.refused.length > 0) {
      console.log(`  not stopped, and still sending: ${r.stopped.refused.join("; ")}. The next kernel-inbound or kernel-opt-out tries again.`);
      return 1;
    }
    return 0;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
