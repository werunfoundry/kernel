#!/usr/bin/env node
/**
 * kernel-verify — run from an instance's root, usually as `pnpm verify`.
 *
 * Not `pnpm doctor`: that is a pnpm command of its own, which runs instead of
 * any script of that name and exits 0.
 *
 * Everything is in `runtime/verify.ts`; this only finds the instance and its
 * environment. The instance is the working directory, as for
 * `kernel-check-instance`. Its `.env` is read if there is one; absent is fine,
 * the variables may come from wherever the process was started.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { verify } from "../runtime/verify.js";

const root = process.cwd();
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

process.exitCode = await verify({ root, env: process.env });
