#!/usr/bin/env node
/**
 * An instance, the way someone outside this repository would get one.
 *
 * Inside the workspace the packages resolve to TypeScript source, through
 * links, with a loader in the tests — three things no instance will have. So
 * nothing run inside the workspace says whether a published kernel works.
 * This does it the long way round (decision 0008), with nothing added to the
 * instance by hand:
 *
 *   1. pack every package, which builds it clean — the tarballs are what a
 *      publish would upload, byte for byte;
 *   2. generate an instance from `template/` into a temporary directory,
 *      outside the workspace, and install those tarballs into it;
 *   3. `kernel-migrate`: install the schemas from what the packages ship;
 *   4. `kernel-check-instance` and `kernel-verify`, on plain Node — no
 *      loader, no flag — which must find the configuration real, and every
 *      experiment type measurable;
 *   5. `kernel-enrol`, three times: a dry run that writes nothing, a live run
 *      that enrols the open accounts' people and skips the protected one, and
 *      a replay that enrols nobody twice. Every run is read back from the
 *      database.
 *
 *   TEST_DATABASE_URL=postgresql://… node scripts/try-instance.mjs
 *
 * With `--manifest <file>`, that manifest replaces the template's, and steps
 * 3 and 4 run against the providers it binds — real ones, with real keys.
 * Step 5 does not: enrolling through a real provider writes to a real
 * workspace, which is never done without someone saying so. The variables the
 * manifest names are passed through from this process's environment, and
 * nothing else is. Keep that manifest outside the repository.
 *
 * Drops the `core`, `relations`, `gtm` and `drizzle` schemas in that
 * database. Point it at a database that exists to be thrown away.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const kernel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.TEST_DATABASE_URL;
const manifestAt = process.argv.indexOf("--manifest");
const realManifest = manifestAt === -1 ? undefined : resolve(process.argv[manifestAt + 1] ?? "");
if (!url) {
  console.error("try-instance: TEST_DATABASE_URL is not set — it needs a database it may wipe.");
  process.exit(2);
}

const PACKAGES = ["core", "domains/relations", "domains/gtm", "adapters"];
const SCHEMAS = ["gtm", "relations", "core", "drizzle"];

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

let failed = false;
const expect = (ok, why) => {
  if (!ok) {
    failed = true;
    console.error(`try-instance: ${why}`);
  }
};

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
  for (const [name, file] of Object.entries(tarballs)) {
    if (pkg.dependencies[name]) pkg.dependencies[name] = `file:${file}`;
  }
  // The template binds no shipped adapter, so it does not depend on them; the
  // instance here does, so that every one is loaded below by its published name.
  pkg.dependencies["@werunfoundry/adapters"] = `file:${tarballs["@werunfoundry/adapters"]}`;
  // Both homes for overrides: pnpm 9 reads package.json, pnpm 10 onwards
  // reads pnpm-workspace.yaml, and outside this repository nothing pins which
  // pnpm runs.
  const overrides = Object.entries(tarballs).map(([n, f]) => [n, `file:${f}`]);
  pkg.pnpm = { overrides: Object.fromEntries(overrides) };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(root, "pnpm-workspace.yaml"), `overrides:\n${overrides.map(([n, f]) => `  "${n}": "${f}"\n`).join("")}`);
  sh("pnpm", ["install"], root);

  /** Credentials for the commands: none for the sandboxes, or those a real manifest names. */
  let credentials = {};
  if (realManifest) {
    const text = readFileSync(realManifest, "utf8");
    writeFileSync(join(root, "manifest.yaml"), text);
    // Only names that are declared and set. Values never reach the output.
    const names = new Set(text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []);
    credentials = Object.fromEntries([...names].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  }
  // Nothing inherited that could load a loader behind a command's back.
  const env = { PATH: process.env.PATH, USER: process.env.USER ?? "", DATABASE_URL: url, DIRECT_URL: url, ...credentials };
  const bin = (name, args = []) => spawnAsync(join(root, "node_modules/.bin", name), args, { cwd: root, env });
  const show = (r) =>
    console.log(`${r.stdout}${r.stderr}`.trim().split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n"));

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  for (const schema of SCHEMAS) await client.query(`drop schema if exists ${schema} cascade`);
  const runRow = async (id) => (await client.query("select status, dry_run from core.run where id = $1", [id])).rows[0];

  step("migrate, with the kernel's own command");
  const migrated = await bin("kernel-migrate");
  show(migrated);
  expect(migrated.status === 0, `kernel-migrate exited ${migrated.status}`);
  const again = await bin("kernel-migrate");
  expect(again.status === 0, `kernel-migrate, run twice, exited ${again.status}`);

  // Every adapter the kernel ships, by the name a binding gives it (0023),
  // loaded by the instance's own Node from the installed pack: a published
  // export that points nowhere passes every check inside the workspace.
  step("every shipped adapter loads by its published name");
  const shipped = sh("git", ["ls-files", "adapters"], kernel)
    .split("\n")
    .filter((f) => /^adapters\/.+\/index\.ts$/.test(f))
    .map((f) => `@werunfoundry/${dirname(f)}`)
    .sort();
  const load = `for (const n of ${JSON.stringify(shipped)}) { const m = await import(n); if (typeof m.default !== "function") throw new Error(n + " has no factory"); console.log("  " + n); }`;
  const loaded = await spawnAsync(process.execPath, ["--input-type=module", "-e", load], { cwd: root, env });
  show(loaded);
  expect(loaded.status === 0, "a shipped adapter does not load from the instance");
  expect(shipped.length > 0, "no shipped adapter was found to load");

  step("the instance checks itself");
  sh("git", ["init", "-q"], root);
  console.log(sh(join(root, "node_modules/.bin/kernel-check-instance"), [], root).trim());

  step(realManifest ? "verify, against the providers the manifest binds" : "verify, against the sandboxes");
  const verified = await bin("kernel-verify");
  show(verified);
  const verifyId = verified.stdout.match(/run: ([0-9a-f-]{36}) opened/)?.[1];
  expect(verified.status === 0, `verify exited ${verified.status}`);
  expect(Boolean(verifyId), "verify opened no run");
  expect(/This configuration is real\./.test(verified.stdout), "verify did not find the configuration real");
  const verifyRow = verifyId ? await runRow(verifyId) : undefined;
  expect(verifyRow?.status === "succeeded" && verifyRow?.dry_run === true, `the verify run reads ${JSON.stringify(verifyRow)}`);

  if (!realManifest) {
    expect(/experiments: 6 of 6 measurable/.test(verified.stdout), "not every experiment type is measurable with the template's sources");

    const enrolArgs = ["--sequence", "welcome", "--channel", "email", "--max-age", "60"];
    const state = join(root, ".sandbox-state.json");
    const enrolled = (out) => Number(out.match(/(?:would enrol|enrolled): (\d+)/)?.[1] ?? -1);
    const runOf = async (out) => {
      const id = out.match(/^run: ([0-9a-f-]{36})/m)?.[1];
      return id ? await runRow(id) : undefined;
    };

    step("enrol, dry run");
    const dry = await bin("kernel-enrol", enrolArgs);
    show(dry);
    expect(dry.status === 0, `the dry run exited ${dry.status}`);
    expect(enrolled(dry.stdout) === 3, "the dry run would not enrol the three open people");
    expect(!existsSync(state), "the dry run wrote the sandbox's state");
    expect((await runOf(dry.stdout))?.dry_run === true, "the dry run is not recorded as one");
    // The registry (0026), read back from the database the packs migrated.
    const registry = async () => (await client.query("select state, count(*)::int as n from gtm.enrolment group by 1 order by 1")).rows;
    const skipsOf = async (out) => {
      const id = out.match(/^run: ([0-9a-f-]{36})/m)?.[1];
      return id ? (await client.query("select reason, count(*)::int as n from gtm.enrolment_skip where run_id = $1 group by 1 order by 1", [id])).rows : [];
    };
    expect(JSON.stringify(await registry()) === "[]", `the dry run wrote the registry: ${JSON.stringify(await registry())}`);
    expect(JSON.stringify(await skipsOf(dry.stdout)) === JSON.stringify([{ reason: "protected", n: 1 }]), "the dry run did not keep its skip");

    step("enrol, live");
    const live = await bin("kernel-enrol", [...enrolArgs, "--live"]);
    show(live);
    expect(live.status === 0, `the live run exited ${live.status}`);
    expect(enrolled(live.stdout) === 3, "the live run did not enrol the three open people");
    expect(/skipped, protected: 1/.test(live.stdout), "the protected account was not skipped as protected");
    const held = existsSync(state) ? Object.keys(JSON.parse(readFileSync(state, "utf8")).enrolments.welcome ?? {}) : [];
    expect(!held.some((e) => e.endsWith("customer.example.net")), "a protected account's person was enrolled");
    expect(held.length === 3, `the sequencer holds ${held.length} people, not 3`);
    const liveRow = await runOf(live.stdout);
    expect(liveRow?.status === "succeeded" && liveRow?.dry_run === false, `the live run reads ${JSON.stringify(liveRow)}`);
    expect(JSON.stringify(await registry()) === JSON.stringify([{ state: "enrolled", n: 3 }]), `the registry reads ${JSON.stringify(await registry())}`);

    step("enrol, replayed");
    const replay = await bin("kernel-enrol", [...enrolArgs, "--live"]);
    show(replay);
    expect(replay.status === 0, `the replay exited ${replay.status}`);
    expect(enrolled(replay.stdout) === 0, "the replay enrolled someone again");
    expect(/skipped, duplicate: 3/.test(replay.stdout), "the replay did not see the three as duplicates");
    expect((replay.stdout.match(/already enrolled in this sequence, by the registry/g) ?? []).length === 3, "the replay did not answer from the registry");
    expect(
      JSON.stringify(await skipsOf(replay.stdout)) === JSON.stringify([{ reason: "protected", n: 1 }, { reason: "duplicate", n: 3 }]),
      "the replay's skips were not kept with their reasons",
    );
  }
  await client.end();
} catch (error) {
  failed = true;
  // A failed command carries its output; without it the report is "failed".
  const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
  console.error(`try-instance: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  if (output) console.error(output.split("\n").slice(-25).join("\n"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  failed ? "\ntry-instance: failed" : "\ntry-instance: an instance generated from the template migrates, verifies and enrols on plain Node",
);
process.exit(failed ? 1 : 0);
