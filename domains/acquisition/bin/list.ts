#!/usr/bin/env node
/**
 * kernel-list — a person constitutes a list (decisions 0037, 0047), run from
 * an instance's root.
 *
 *   kernel-list --key <key> --from-run <runId> --by <who> [--description "<what>"] [--dry-run]
 *   kernel-list --key <key> --from-file <path> --by <who> [--description "<what>"] [--dry-run]
 *
 * From the people a live sourcing run kept, or from a file with one address
 * or domain per line, each naming a recorded subject. Never from a live
 * query: the list is frozen, and where its members came from is kept beside
 * it.
 *
 * A list is a selection, never a permission: nobody is filtered for an
 * opt-out or for protection here. Both are read when something is sent.
 *
 * For a person, at a terminal: it refuses to write without one, and asks for
 * the key to be typed again before it does. A key that already names a list
 * is refused. `--dry-run` shows who would be on it, and writes nothing.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { connect } from "@werunfoundry/core/runtime/connect";

import type { Selection } from "../runtime/list.js";
import { constituteSelection, existingList, selectFromLines, selectFromRun } from "../runtime/list.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("list: DATABASE_URL is not set.");
    return 1;
  }

  const key = value("key")?.trim() ?? "";
  const fromRun = value("from-run");
  const fromFile = value("from-file");
  const by = value("by") ?? "";
  const description = value("description");
  const dryRun = flag("dry-run");
  if (!key || !by || !fromRun === !fromFile) {
    console.log("list: --key, --by, and one of --from-run or --from-file, are required.");
    return 1;
  }
  if (!dryRun && !process.stdin.isTTY) {
    console.log("list: a person constitutes a list, at a terminal. Nothing was written.");
    return 1;
  }
  let text = "";
  if (fromFile) {
    try {
      text = readFileSync(resolve(root, fromFile), "utf8");
    } catch (error) {
      console.log(`list: cannot read ${fromFile} — ${(error as Error).message}`);
      return 1;
    }
  }

  let connection;
  try {
    connection = await connect(url, root, "list");
  } catch (error) {
    console.log(`list: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const existing = await existingList(connection.db, key);
    if (existing) {
      console.log(`list: a list ${key} already exists, constituted on ${existing.createdAt.toISOString()} by ${existing.actorId ?? "nobody named"} with ${existing.members.length} members. Nothing was written.`);
      return 1;
    }
    let selection: Selection;
    try {
      selection = fromRun ? await selectFromRun(connection.db, fromRun) : await selectFromLines(connection.db, text, basename(fromFile!));
    } catch (error) {
      console.log(`list: ${(error as Error).message}. Nothing was written.`);
      return 1;
    }
    console.log(`list ${key}: ${selection.members.length} members, from ${fromRun ? `run ${fromRun}` : basename(fromFile!)}`);
    for (const line of selection.shown) console.log(`  - ${line}`);
    console.log("A list is a selection, never a permission: opt-outs and protection are read when something is sent, not here.");
    if (dryRun) {
      console.log("dry run — nothing was written.");
      return 0;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const again = await rl.question(`Constitute and seal list ${key}? It cannot be changed after. Type the key again to confirm: `).finally(() => rl.close());
    if (again.trim() !== key) {
      console.log("list: what was typed does not match. Nothing was written.");
      return 1;
    }
    const r = await constituteSelection(connection.db, { key, ...(description ? { description } : {}), selection, by });
    console.log(`run: ${r.runId} — ${r.constituted ? `list ${key} constituted and sealed, ${r.members} members` : `a list ${key} was constituted meanwhile; it stands, and nothing changed`}`);
    return 0;
  } catch (error) {
    console.log(`list: ${(error as Error).message}`);
    return 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
