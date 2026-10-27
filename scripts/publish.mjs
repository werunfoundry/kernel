#!/usr/bin/env node
/**
 * Publish the five engine packages for the current commit (decision 0073).
 *
 * The version is `0.1.0-main.g` and the first seven characters of HEAD — seven
 * cut from the commit, not git's abbreviated revision, which grows. The `g`
 * is why a sha of digits with a leading zero (`0123456`) is still a version:
 * without it, npm refuses the publish and the error does not say why.
 *
 * The version is applied to each package.json and is never committed. A re-run
 * finds packages already at that version and continues; it publishes what is
 * absent. A sha is a version only when the five are present — checked at the
 * end, and the job stays red until they are.
 *
 *   node scripts/publish.mjs
 *
 * Needs NODE_AUTH_TOKEN (or the registry's equivalent) and a checkout of the
 * commit being published. Runs `pnpm publish`: the packages depend on each
 * other by `workspace:`, and only pnpm rewrites that to the version it is
 * publishing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kernel = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The five, in dependency order — never the template. */
export const PACKAGES = [
  { dir: "core", name: "@werunfoundry/core" },
  { dir: "domains/relations", name: "@werunfoundry/relations" },
  { dir: "domains/acquisition", name: "@werunfoundry/acquisition" },
  { dir: "api", name: "@werunfoundry/api" },
  { dir: "adapters", name: "@werunfoundry/adapters" },
];

/**
 * The version a commit publishes under. Seven characters of the full sha, with
 * the `g` that makes a numeric leading-zero sha a legal prerelease identifier.
 */
export function versionOf(sha) {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,}$/i.test(sha)) {
    throw new Error(`publish: need a git sha, got ${JSON.stringify(sha)}`);
  }
  return `0.1.0-main.g${sha.slice(0, 7).toLowerCase()}`;
}

function sh(cmd, args, cwd, opts = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    ...opts,
  });
}

function setVersion(dir, version) {
  const path = join(kernel, dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Whether the registry already holds this name at this version. */
function onRegistry(name, version) {
  const r = sh("npm", ["view", `${name}@${version}`, "version"], kernel);
  if (r.status === 0 && r.stdout.trim() === version) return { present: true };
  const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
  if (r.status !== 0 && /E404|404 Not Found|is not in this registry/i.test(err)) {
    return { present: false };
  }
  return { present: false, error: err.trim() || `npm view exited ${r.status}` };
}

function publishOne(dir, name, version) {
  const cwd = join(kernel, dir);
  console.log(`\n— ${name}@${version}`);
  const seen = onRegistry(name, version);
  if (seen.error) {
    console.error(`publish: could not ask the registry about ${name}@${version}:\n${seen.error}`);
    process.exit(1);
  }
  if (seen.present) {
    console.log(`already on the registry — leaving it`);
    return;
  }
  // --no-git-checks: the version was applied in place and is not committed.
  // --tag main: without it, npm moves latest, including for a prerelease.
  // --provenance: the registry attests the link to this commit (0073).
  // --access public: a scoped package is private by default; without it, 402.
  const r = sh(
    "pnpm",
    ["publish", "--tag", "main", "--provenance", "--no-git-checks", "--access", "public"],
    cwd,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    console.error(`publish: pnpm publish failed for ${name}@${version}`);
    if (r.stdout) process.stderr.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  console.log(`published`);
}

function main() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: kernel, encoding: "utf8" }).trim();
  const version = versionOf(sha);
  console.log(`publish: ${version} (commit ${sha})`);

  for (const { dir } of PACKAGES) setVersion(dir, version);

  for (const { dir, name } of PACKAGES) publishOne(dir, name, version);

  // A sha is a version only when the five are present (0073). Three of five
  // is not that commit; an instance that pinned them would run a mix no
  // commit built.
  const missing = [];
  for (const { name } of PACKAGES) {
    const seen = onRegistry(name, version);
    if (seen.error) {
      console.error(`publish: could not confirm ${name}@${version}:\n${seen.error}`);
      process.exit(1);
    }
    if (!seen.present) missing.push(name);
  }
  if (missing.length) {
    console.error(
      `publish: ${version} is not a version — missing ${missing.join(", ")}. ` +
        `A sha is a version only when the five packages are on the registry at it (decision 0073).`,
    );
    process.exit(1);
  }
  console.log(`\npublish: ${version} — the five are on the registry`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
