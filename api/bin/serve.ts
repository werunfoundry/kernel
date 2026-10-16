#!/usr/bin/env node
/**
 * kernel-api — serve the kernel's HTTP API (decision 0040), from an
 * instance's root.
 *
 * Needs `KERNEL_API_TOKEN` (at least 32 characters) and `KERNEL_API_PORT`.
 * Listens on `KERNEL_API_HOST`, or on the loopback address when none is
 * given: exposing it beyond the machine is the instance's decision to make.
 */

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import { createApi, MIN_TOKEN } from "../server.js";

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const token = process.env.KERNEL_API_TOKEN ?? "";
  const port = Number(process.env.KERNEL_API_PORT);
  if (token.length < MIN_TOKEN) {
    console.log(`api: KERNEL_API_TOKEN is required, at least ${MIN_TOKEN} characters. Nothing was started.`);
    return 1;
  }
  if (!Number.isInteger(port) || port < 1) {
    console.log("api: KERNEL_API_PORT is required. Nothing was started.");
    return 1;
  }
  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("api: DATABASE_URL is not set.");
    return 1;
  }
  const connection = await connect(url, root, "api");
  const host = process.env.KERNEL_API_HOST ?? "127.0.0.1";
  const server = createServer(createApi({ db: connection.db, domains: booted.domains, token }));
  server.listen(port, host, () => console.log(`api: listening on ${host}:${port}`));
  const stop = () => server.close(() => void connection.end().finally(() => process.exit(0)));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return 0;
}

process.exitCode = await main();
