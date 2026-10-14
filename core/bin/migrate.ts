#!/usr/bin/env node
/**
 * kernel-migrate — run from an instance's root, usually as `pnpm migrate`.
 * Installs the schemas of the core and of every enabled domain, in
 * dependency order, from the packages the instance installed. Reads
 * DIRECT_URL, the direct endpoint a transaction pooler cannot replace, and
 * falls back to DATABASE_URL.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { migrate } from "../runtime/migrate.js";

const root = process.cwd();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: neither DIRECT_URL nor DATABASE_URL is set.");
  process.exitCode = 1;
} else {
  process.exitCode = await migrate({ root, url });
}
