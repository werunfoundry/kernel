#!/usr/bin/env node
/**
 * kernel-inbound — read what came back from every inbound source, after its
 * cursor (decisions 0017, 0039), run from an instance's root.
 *
 *   kernel-inbound --pages <n>           dry run: the first page of each source, checked
 *   kernel-inbound --pages <n> --live    store events, touches and opt-outs; advance cursors
 *
 * Pulled, never pushed: when it runs is the instance's business — a schedule,
 * or a person. `--pages` has no default: how far one pull goes is the
 * caller's to say.
 *
 * Then every sequencer that declares 0051's verb 4 served has its
 * unsubscribes read, in full: the pull has no cursor (`runtime/unsubscribes`),
 * so `--pages` does not bound it; the adapter's binding does.
 *
 * Then every sequencer that declares 0051's verb 2 served has its sends
 * read after its cursor, each recorded as an outbound touch tied to the
 * message its enrolment's plan names (`runtime/touches`). Its adapter's
 * binding bounds it too.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import { pullInbound } from "../runtime/inbound.js";
import { pullTouches } from "../runtime/touches.js";
import { pullUnsubscribes } from "../runtime/unsubscribes.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const pages = Number(value("pages"));
  if (!Number.isInteger(pages) || pages < 1) {
    console.log("inbound: --pages <n> is required: how many pages one pull reads from each source.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\ninbound: boot refused. Nothing was opened or called.");
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("inbound: DATABASE_URL is not set — a run must be recorded.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "inbound");
  } catch (error) {
    console.log(`inbound: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const declared = {
      eventTypes: new Set(booted.domains.flatMap((d) => d.eventTypes ?? [])),
      channels: new Set(booted.domains.flatMap((d) => d.channels ?? [])),
    };
    const deps = { db: connection.db, registry: booted.registry, identity: booted.identity, declared };
    const request = { dryRun: !flag("live"), actor: { type: "human" as const }, trigger: "cli" as const };
    let reports;
    let unsubscribes;
    let sends;
    try {
      reports = await pullInbound(deps, { ...request, maxPages: pages });
      unsubscribes = await pullUnsubscribes(deps, request);
      sends = await pullTouches(deps, request);
    } catch (error) {
      const cause = (error as Error).cause;
      console.log(`inbound: ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
      console.log("     have the engine's migrations been applied?");
      return 1;
    }
    if (reports.length === 0) console.log("inbound: no source is bound to the inbound contract.");
    for (const r of reports) {
      console.log(`run: ${r.runId} — ${r.provider} — ${flag("live") ? "live" : "dry run"}`);
      if (r.stoppedBy) console.log(`  stopped: ${r.stoppedBy}`);
      console.log(`  pages: ${r.pages}, events read: ${r.read}`);
      if (flag("live")) {
        console.log(`  recorded: ${r.recorded}, already stored: ${r.replayed}`);
        console.log(`  touches: ${r.touches}, opt-outs: ${r.optOuts}, about nobody recorded: ${r.unknownPeople}`);
        console.log(`  no touch, not the person's own act (0071): ${r.notTheirAct}`);
        console.log(`  opted out, stopped at the provider: ${r.stopped.suspended} suspended, ${r.stopped.byAddress} stopped by address only (left pending, 0060), ${r.stopped.notHeld} no longer held there`);
      } else {
        console.log(`  opted out, would be stopped at the provider: ${r.stopped.would}`);
      }
      console.log(`  cursor: ${r.cursor ?? "(none yet)"}`);
    }
    if (unsubscribes.length === 0) console.log("inbound: no sequencer serves the unsubscribes pull.");
    for (const r of unsubscribes) {
      console.log(`run: ${r.runId} — ${r.provider}, unsubscribes — ${flag("live") ? "live" : "dry run"}`);
      if (r.stoppedBy) console.log(`  stopped: ${r.stoppedBy}`);
      console.log(`  unsubscribes read: ${r.read}${r.complete ? "" : " (only part of them)"}`);
      if (flag("live")) {
        console.log(`  recorded: ${r.recorded}, already stored: ${r.replayed}`);
        console.log(`  opt-outs: ${r.optOuts}, about nobody recorded: ${r.unknownPeople}`);
        console.log(`  opted out, stopped at the provider: ${r.stopped.suspended} suspended, ${r.stopped.byAddress} stopped by address only (left pending, 0060), ${r.stopped.notHeld} no longer held there`);
      } else {
        console.log(`  opted out, would be stopped at the provider: ${r.stopped.would}`);
      }
    }
    if (sends.length === 0) console.log("inbound: no sequencer serves the touches pull.");
    for (const r of sends) {
      console.log(`run: ${r.runId} — ${r.provider}, sends — ${flag("live") ? "live" : "dry run"}`);
      if (r.stoppedBy) console.log(`  stopped: ${r.stoppedBy}`);
      console.log(`  sends read: ${r.read}${r.complete ? "" : " (only part of them)"}`);
      if (flag("live")) {
        console.log(`  touches recorded: ${r.recorded}, of them tied to their message: ${r.matched}, already stored: ${r.replayed}, to nobody on record: ${r.unknownPeople}`);
      }
      console.log(`  cursor: ${r.cursor ?? "(none yet)"}`);
    }
    return [...reports, ...unsubscribes, ...sends].every((r) => !r.stoppedBy) ? 0 : 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
