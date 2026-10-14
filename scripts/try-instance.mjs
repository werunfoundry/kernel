#!/usr/bin/env node
/**
 * An instance, the way someone outside this repository would get one.
 *
 * Inside the workspace the packages resolve to TypeScript source, through
 * links, with a loader in the tests — three things no instance will have. So
 * nothing run inside the workspace says whether a published kernel works.
 * This does it the long way round (decision 0008):
 *
 *   1. pack every package, which builds it clean — the tarballs are what a
 *      publish would upload, byte for byte;
 *   2. generate an instance from `template/` into a temporary directory,
 *      outside the workspace, and install those tarballs into it;
 *   3. apply the migrations the packages ship, from the instance's own
 *      `node_modules`, to a real database;
 *   4. run the instance's checks and its `verify`, on plain Node — no loader,
 *      no flag — against a provider that answers;
 *   5. fail unless the run was opened, the provider was called with its id,
 *      and the run was closed as succeeded.
 *
 *   TEST_DATABASE_URL=postgresql://… node scripts/try-instance.mjs
 *
 * Drops and recreates the `core`, `relations` and `gtm` schemas in that
 * database. Point it at a database that exists to be thrown away.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const kernel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("try-instance: TEST_DATABASE_URL is not set — it needs a database it may wipe.");
  process.exit(2);
}

/** In dependency order: the order the migrations must be applied in. */
const PACKAGES = ["core", "domains/relations", "domains/gtm"];
const SCHEMAS = ["gtm", "relations", "core"];

const work = mkdtempSync(join(tmpdir(), "try-instance-"));
const packs = join(work, "packs");
const root = join(work, "instance");
const step = (what) => console.log(`\n— ${what}`);

const sh = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, ...env } });

function spawnAsync(cmd, args, options) {
  return new Promise((done) => {
    const child = spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

let server;
let failed = false;

try {
  step("pack");
  for (const pkg of PACKAGES) sh("pnpm", ["pack", "--pack-destination", packs], join(kernel, pkg));
  const tarballs = Object.fromEntries(
    readdirSync(packs).map((f) => [`@werunfoundry/${f.replace(/^werunfoundry-|-\d+\.\d+\.\d+\.tgz$/g, "")}`, join(packs, f)]),
  );
  console.log(Object.keys(tarballs).join(", "));

  step("generate and install, outside the workspace");
  sh(process.execPath, [join(kernel, "scripts/new-instance.mjs"), root], kernel);
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // The tarballs depend on each other by version, and that version is not on
  // a registry yet: every reference, direct or not, is pointed at the file.
  for (const [name, file] of Object.entries(tarballs)) {
    if (pkg.dependencies[name]) pkg.dependencies[name] = `file:${file}`;
  }
  // Both homes for overrides: pnpm 9 reads package.json, pnpm 10 onwards
  // reads pnpm-workspace.yaml, and outside this repository nothing pins which
  // pnpm runs.
  const overrides = Object.entries(tarballs).map(([n, f]) => [n, `file:${f}`]);
  pkg.pnpm = { overrides: Object.fromEntries(overrides) };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `overrides:\n${overrides.map(([n, f]) => `  "${n}": "${f.startsWith("file:") ? f : `file:${f}`}"\n`).join("")}`,
  );
  sh("pnpm", ["install"], root);

  step("migrate, from what the packages ship");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const schema of SCHEMAS) await client.query(`drop schema if exists ${schema} cascade`);
  for (const pkgDir of PACKAGES) {
    const name = pkgDir.split("/").pop();
    const dir = join(root, "node_modules/@werunfoundry", name, "db/migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(dir, file), "utf8"));
      console.log(`${name}/${file}`);
    }
  }

  step("the instance checks itself");
  sh("git", ["init", "-q"], root);
  console.log(sh(join(root, "node_modules/.bin/kernel-check-instance"), [], root).trim());

  step("verify, on plain Node");
  const calls = [];
  server = createServer((req, res) => {
    calls.push({ path: req.url, runId: req.headers["x-run-id"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const manifest = join(root, "manifest.yaml");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace("https://api.example.invalid/v1", `http://127.0.0.1:${server.address().port}`),
  );

  // Asynchronous, and not for style: the provider above answers from this
  // process, and a synchronous spawn would stop it answering — the script
  // under test would wait on a server that is waiting on it.
  const run = await spawnAsync(join(root, "node_modules/.bin/kernel-verify"), [], {
    cwd: root,
    // Nothing inherited that could load a loader behind this script's back.
    env: { PATH: process.env.PATH, USER: process.env.USER ?? "", DATABASE_URL: url, EXAMPLE_CRM_TOKEN: "try-instance" },
  });
  console.log(`${run.stdout}${run.stderr}`.trim());

  const id = run.stdout.match(/run: ([0-9a-f-]{36}) opened/)?.[1];
  const row = id ? (await client.query("select status, dry_run from core.run where id = $1", [id])).rows[0] : undefined;
  await client.end();

  const expect = [
    [run.status === 0, `verify exited ${run.status}`],
    [Boolean(id), "no run was opened"],
    [calls.some((c) => c.runId === id), "the provider was never called with the run's id"],
    [row?.status === "succeeded" && row?.dry_run === true, `the run row reads ${JSON.stringify(row)}`],
  ];
  for (const [ok, why] of expect) {
    if (!ok) {
      failed = true;
      console.error(`try-instance: ${why}`);
    }
  }
} catch (error) {
  failed = true;
  // A failed command carries its output; without it the report is "failed".
  const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
  console.error(`try-instance: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  if (output) console.error(output.split("\n").slice(-25).join("\n"));
} finally {
  server?.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? "\ntry-instance: failed" : "\ntry-instance: an instance installed from the packs runs on plain Node");
process.exit(failed ? 1 : 0);
