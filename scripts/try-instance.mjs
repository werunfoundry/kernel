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
 *   5. `kernel-source`, dry and live, excluding by protection and by the
 *      CRM before and after completion; then a person's acts (0047) — each
 *      refused without a terminal, shown on a dry run, and a list and a
 *      decision written through a pseudo-terminal; then `kernel-enrol
 *      --list`, carrying the messages drafted and approved for that list
 *      (0064): a dry run that writes nothing, a live run, and a replay that
 *      enrols nobody twice. Every run is read back from the database.
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
 * Drops the `core`, `relations`, `acquisition` (and its former name, `gtm`) and `drizzle` schemas in that
 * database. Point it at a database that exists to be thrown away.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

const PACKAGES = ["core", "domains/relations", "domains/acquisition", "api", "adapters"];
// `gtm` is acquisition's former name (0046): a database earlier runs used still has it.
const SCHEMAS = ["acquisition", "gtm", "relations", "core", "drizzle"];

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
  // The API is the instance's choice to serve (0040); here it is installed to be started once.
  pkg.dependencies["@werunfoundry/api"] = `file:${tarballs["@werunfoundry/api"]}`;
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
    // A fingerprint version's variable is derived from its label (0058).
    const names = new Set([...(text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []), ...[...text.matchAll(/label:\s*([A-Z0-9]+)/g)].map((m) => `KERNEL_FINGERPRINT_${m[1]}`)]);
    credentials = Object.fromEntries([...names].filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
  }
  // Nothing inherited that could load a loader behind a command's back.
  const env = { PATH: process.env.PATH, USER: process.env.USER ?? "", DATABASE_URL: url, DIRECT_URL: url, ...credentials };
  const bin = (name, args = []) => spawnAsync(join(root, "node_modules/.bin", name), args, { cwd: root, env });
  const show = (r) =>
    console.log(`${r.stdout}${r.stderr}`.trim().split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n"));

  // The template ships no version of the register's secret: one is
  // generated (0058). As a person would, with the kernel's own command: its
  // line goes into the environment, its block into the manifest. The secret
  // is not shown.
  if (!realManifest) {
    step("the register's first version, generated by kernel-fingerprint");
    const generated = await bin("kernel-fingerprint", ["--label", "V1", "--writes", "--reason", "the instance's first version"]);
    expect(generated.status === 0, `kernel-fingerprint exited ${generated.status}`);
    const secret = generated.stdout.match(/^KERNEL_FINGERPRINT_V1=([0-9a-f]{64})$/m)?.[1];
    const block = generated.stdout.slice(generated.stdout.indexOf("\nfingerprints:\n") + 1);
    expect(Boolean(secret) && block.startsWith("fingerprints:\n  writes: V1\n"), "kernel-fingerprint did not print a secret and a block for the manifest");
    console.log(generated.stdout.replace(/=[0-9a-f]{64}$/m, "=<the secret, not shown>").trim());
    writeFileSync(join(root, "manifest.yaml"), `${readFileSync(join(root, "manifest.yaml"), "utf8")}\n${block}`);
    env.KERNEL_FINGERPRINT_V1 = secret;
  }

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
  expect(/core: applied \d+ migration/.test(migrated.stdout), "the first migrate did not say it applied the core's migrations");
  expect(!/applied \d+ migration/.test(again.stdout) && /nothing to apply/.test(again.stdout), "the second migrate did not say it applied nothing");

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

  // The instance's own `pnpm typecheck`, with the TypeScript it declares. A
  // template that declared none ran whatever `tsc` the machine had, and an
  // old one refused the tsconfig outright.
  step("the instance typechecks itself");
  const typed = await spawnAsync("pnpm", ["typecheck"], { cwd: root, env });
  show(typed);
  expect(typed.status === 0, "the instance does not typecheck with what it declares");

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
  expect(!/nobody has stood behind this since/.test(verified.stdout), "a new instance reports its example truth as stale");
  const verifyRow = verifyId ? await runRow(verifyId) : undefined;
  expect(verifyRow?.status === "succeeded" && verifyRow?.dry_run === true, `the verify run reads ${JSON.stringify(verifyRow)}`);

  if (!realManifest) {
    expect(/experiments: 6 of 6 measurable/.test(verified.stdout), "not every experiment type is measurable with the template's sources");

    const state = join(root, ".sandbox-state.json");
    const enrolled = (out) => Number(out.match(/(?:would enrol|enrolled): (\d+)/)?.[1] ?? -1);
    const runOf = async (out) => {
      const id = out.match(/^run: ([0-9a-f-]{36})/m)?.[1];
      return id ? await runRow(id) : undefined;
    };
    // The registry (0026), read back from the database the packs migrated.
    const registry = async () => (await client.query("select state, count(*)::int as n from acquisition.enrolment group by 1 order by 1")).rows;

    // Inbound (0039): pulled after a cursor, stored once, nothing written by a dry run.
    const events = async () => (await client.query("select kind, count(*)::int as n from core.event group by 1 order by 1")).rows;
    step("inbound, dry run");
    const inDry = await bin("kernel-inbound", ["--pages", "5"]);
    show(inDry);
    expect(inDry.status === 0, `the inbound dry run exited ${inDry.status}`);
    expect(/events read: 2/.test(inDry.stdout), "the inbound dry run did not read the sandbox's two events");
    expect(JSON.stringify(await events()) === "[]", "the inbound dry run stored events");

    step("inbound, live");
    const inLive = await bin("kernel-inbound", ["--pages", "5", "--live"]);
    show(inLive);
    expect(inLive.status === 0, `the inbound live run exited ${inLive.status}`);
    expect(/recorded: 2, already stored: 0/.test(inLive.stdout), "the inbound live run did not store the two events");
    expect(
      JSON.stringify(await events()) === JSON.stringify([{ kind: "acquisition.meeting_booked", n: 1 }, { kind: "acquisition.reply", n: 1 }]),
      `core.event reads ${JSON.stringify(await events())}`,
    );

    step("inbound, again");
    const inAgain = await bin("kernel-inbound", ["--pages", "5", "--live"]);
    show(inAgain);
    expect(/recorded: 0/.test(inAgain.stdout), "the second pull stored events again: the cursor did not hold");

    // The API (0040), from the pack, on plain Node: the token or nothing.
    step("api");
    const port = await new Promise((done) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const p = probe.address().port;
        probe.close(() => done(p));
      });
    });
    const apiToken = randomBytes(24).toString("hex");
    const api = spawn(join(root, "node_modules/.bin", "kernel-api"), [], { cwd: root, env: { ...env, KERNEL_API_TOKEN: apiToken, KERNEL_API_PORT: String(port) } });
    try {
      await new Promise((ready, fail) => {
        let out = "";
        const timer = setTimeout(() => fail(new Error(`kernel-api did not start: ${out}`)), 20000);
        const read = (b) => {
          out += b;
          if (/listening on/.test(out)) {
            clearTimeout(timer);
            ready();
          }
        };
        api.stdout.on("data", read);
        api.stderr.on("data", read);
        api.on("exit", (code) => fail(new Error(`kernel-api exited ${code}: ${out}`)));
      });
      const health = (auth) => fetch(`http://127.0.0.1:${port}/v1/health`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
      expect((await health(apiToken)).status === 200, "kernel-api did not answer with its token");
      expect((await health(undefined)).status === 401, "kernel-api answered without a token");
      console.log(`kernel-api answered on ${port}, with the token and only with it`);
    } finally {
      api.kill();
    }

    // The sourcing path (0031): the protected account and the one the CRM
    // holds are excluded before anyone there is looked up; Bo, whom the CRM
    // knows by address, after; Ada is kept.
    const sourceArgs = ["--max-age", "60", "--max-people", "10", "--want", "email"];
    const outcomesOf = async (out) => {
      const id = out.match(/^run: ([0-9a-f-]{36})/m)?.[1];
      return id
        ? (await client.query("select pass, outcome, count(*)::int as n, count(person_id)::int as recorded from acquisition.sourcing_result where run_id = $1 group by 1, 2 order by 1, 2", [id])).rows
        : [];
    };
    const expected = (recorded) => [
      { pass: "company", outcome: "protected", n: 1, recorded: 0 },
      { pass: "company", outcome: "known_to_crm", n: 1, recorded: 0 },
      { pass: "person", outcome: "kept", n: 1, recorded },
      { pass: "person", outcome: "known_to_crm", n: 1, recorded: 0 },
    ];

    step("source, dry run");
    const sourcedDry = await bin("kernel-source", sourceArgs);
    show(sourcedDry);
    expect(sourcedDry.status === 0, `the sourcing dry run exited ${sourcedDry.status}`);
    expect(/company pass, before anything was spent — excluded: 2/.test(sourcedDry.stdout), "the company pass did not exclude the protected account and the CRM's");
    expect(/would keep: 1/.test(sourcedDry.stdout), "the sourcing dry run would not keep Ada");
    expect(JSON.stringify(await outcomesOf(sourcedDry.stdout)) === JSON.stringify(expected(0)), `the sourcing dry run kept ${JSON.stringify(await outcomesOf(sourcedDry.stdout))}`);

    step("source, live");
    const sourcedLive = await bin("kernel-source", [...sourceArgs, "--live"]);
    show(sourcedLive);
    expect(sourcedLive.status === 0, `the sourcing live run exited ${sourcedLive.status}`);
    expect(/kept: 1/.test(sourcedLive.stdout), "the sourcing live run did not keep Ada");
    expect(JSON.stringify(await outcomesOf(sourcedLive.stdout)) === JSON.stringify(expected(1)), `the sourcing live run kept ${JSON.stringify(await outcomesOf(sourcedLive.stdout))}`);

    const sourcingRun = sourcedLive.stdout.match(/^run: ([0-9a-f-]{36})/m)?.[1] ?? "";

    // A person's acts (0047), from the packs, on plain Node. Without a
    // terminal each writes nothing; `script` gives one a pseudo-terminal and
    // types the confirmation, as a person would.
    const count = async (table) => (await client.query(`select count(*)::int as n from ${table}`)).rows[0].n;
    const typed = (name, args, input) =>
      new Promise((done) => {
        const quote = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
        const child = spawn("script", ["-qec", [join(root, "node_modules/.bin", name), ...args].map(quote).join(" "), "/dev/null"], { cwd: root, env });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stdout += d));
        child.stdin.end(input);
        child.on("close", (status) => done({ status, stdout, stderr: "" }));
      });

    step("a list from the sourcing run: refused without a terminal, shown dry, constituted at one");
    const listArgs = ["--key", "sourced", "--from-run", sourcingRun, "--by", "an operator"];
    const listBare = await bin("kernel-list", listArgs);
    expect(listBare.status === 1 && /at a terminal\. Nothing was written/.test(listBare.stdout), `kernel-list without a terminal: ${listBare.stdout.trim()}`);
    const listDry = await bin("kernel-list", [...listArgs, "--dry-run"]);
    show(listDry);
    expect(listDry.status === 0 && /1 members/.test(listDry.stdout) && /ada@open\.example\.com/.test(listDry.stdout), "the dry run of kernel-list did not show Ada alone");
    expect((await count("relations.list")) === 0, "a list was written without a terminal, or by a dry run");
    const listed = await typed("kernel-list", listArgs, "sourced\n");
    expect(listed.status === 0 && /list sourced constituted and sealed, 1 members/.test(listed.stdout), `kernel-list at a terminal: ${listed.stdout.trim().split("\n").pop()}`);
    expect((await count("relations.list_member")) === 1, "the list does not hold Ada");

    step("a stage and a relationship, shown dry");
    const ada = (await client.query("select p.email, c.domain from relations.person p join relations.company c on c.id = p.company_id where lower(p.email) = 'ada@open.example.com'")).rows[0];
    const stageDry = await bin("kernel-stage", ["--person", ada?.email ?? "", "--stage", "engaged", "--at", "2026-09-01", "--by", "an operator", "--dry-run"]);
    show(stageDry);
    expect(stageDry.status === 0 && /would declare ada@open\.example\.com engaged/.test(stageDry.stdout), "kernel-stage did not show its dry run");
    const relDry = await bin("kernel-relationship", ["--company", ada?.domain ?? "", "--status", "customer", "--at", "2026-09-01", "--by", "an operator", "--dry-run"]);
    show(relDry);
    expect(relDry.status === 0 && /would declare .* customer/.test(relDry.stdout), "kernel-relationship did not show its dry run");
    expect((await count("acquisition.person_state")) + (await count("relations.relationship")) === 0, "a dry run declared something");

    step("a decision, recorded at a terminal");
    await client.query("insert into core.experiment (slug, type, hypothesis_ref) values ('try-decide', 'campaign', 'https://example.com/h')");
    const decided = await typed("kernel-decide", ["--experiment", "try-decide", "--conclusion", "continue", "--no-readings", "--by", "an operator"], "try-decide\n");
    expect(decided.status === 0 && /decision .* recorded on try-decide/.test(decided.stdout), `kernel-decide at a terminal: ${decided.stdout.trim().split("\n").pop()}`);
    expect((await count("core.decision")) === 1, "the decision was not recorded");
    const triggers = (await client.query("select distinct trigger from core.run where process_key in ('acquisition.list.constitute', 'core.decision.record')")).rows;
    expect(JSON.stringify(triggers) === JSON.stringify([{ trigger: "cli" }]), `a person's acts recorded their channel as ${JSON.stringify(triggers)}, not cli (0048)`);

    // The enrolment, which carries the kernel's messages (0064), from the
    // packs, on plain Node: the list just constituted, drafted, approved by a
    // person, then enrolled through `kernel-enrol --list` into a sequence of
    // the sandbox, which reads its steps and keeps the variables it was
    // handed. Solicited: the sandbox does not pull what it sent, so an
    // unsolicited enrolment through it cannot be capped (0064 §6).
    step("the enrolment from a list, carrying the kernel's messages");
    const experimentId = (await client.query("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('try-send', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).rows[0].id;
    const templateId = (await client.query("insert into acquisition.template (experiment_id, variant, step, channel, subject, body) values ($1, 'a', 1, 'email', 'A subject', 'A first line.') returning id", [experimentId])).rows[0].id;
    const draftScript = `
      import { boot } from "@werunfoundry/core/runtime/boot";
      import { connect } from "@werunfoundry/core/runtime/connect";
      import { approve } from "@werunfoundry/acquisition/runtime/draft";
      import { draftFromList } from "@werunfoundry/acquisition/runtime/send";
      const root = process.cwd();
      const booted = await boot({ root, env: process.env });
      if (!booted.ok) throw new Error("boot refused: " + booted.issues.map((i) => i.message).join("; "));
      const { db, end } = await connect(process.env.DATABASE_URL, root, "try-draft");
      const actor = { type: "agent", id: "a drafting agent" };
      const drafted = await draftFromList(db, booted.fingerprints, { listKey: "sourced", experimentId: ${JSON.stringify(experimentId)}, templateId: ${JSON.stringify(templateId)}, compose: (_p, t) => ({ subject: t.subject, body: t.body }), gate: { autonomyAfter: 5 }, dryRun: false, trigger: "cli", actor });
      for (const d of drafted.drafted) await approve(db, d.draftId, { by: "an operator" }, { actor: { type: "human", id: "an operator" } });
      await end();
      console.log(JSON.stringify({ drafted: drafted.drafted.map((d) => d.outcome) }));
    `;
    const drafting = await spawnAsync(process.execPath, ["--input-type=module", "-e", draftScript], { cwd: root, env });
    show(drafting);
    expect(drafting.status === 0, "drafting from the list did not run from the packs");
    const draftedSaid = JSON.parse(drafting.stdout.trim().split("\n").pop() || "{}");
    expect(JSON.stringify(draftedSaid) === JSON.stringify({ drafted: ["awaiting_review"] }), `drafting reported ${JSON.stringify(draftedSaid)}`);
    const carryArgs = ["--sequence", "follow-up", "--channel", "email", "--max-age", "60", "--list", "sourced", "--experiment", experimentId];
    const unsolicited = await bin("kernel-enrol", [...carryArgs, "--cap-max", "3", "--cap-days", "30", "--live"]);
    expect(unsolicited.status === 1 && /cannot be capped \(decision 0064 §6\)/.test(unsolicited.stdout), `kernel-enrol --list without --solicited: ${unsolicited.stdout.trim().split("\n").pop()}`);
    const messages = () => count("relations.message");
    const dry = await bin("kernel-enrol", [...carryArgs, "--solicited"]);
    show(dry);
    expect(dry.status === 0 && enrolled(dry.stdout) === 1, `kernel-enrol --list, dry: ${dry.stdout.trim().split("\n").pop()}`);
    expect(/protected accounts read: 1 distinct/.test(dry.stdout), "the dry run did not read the protected set");
    expect((await runOf(dry.stdout))?.dry_run === true, "the dry run is not recorded as one");
    expect(!existsSync(state), "the dry run wrote the sandbox's state");
    expect(JSON.stringify(await registry()) === "[]" && (await messages()) === 0, "the dry run wrote the registry or a message");
    const carried = await bin("kernel-enrol", [...carryArgs, "--solicited", "--live"]);
    show(carried);
    expect(carried.status === 0 && enrolled(carried.stdout) === 1, `kernel-enrol --list --solicited --live: ${carried.stdout.trim().split("\n").pop()}`);
    const carriedRow = await runOf(carried.stdout);
    expect(carriedRow?.status === "succeeded" && carriedRow?.dry_run === false, `the live run reads ${JSON.stringify(carriedRow)}`);
    expect(JSON.stringify(await registry()) === JSON.stringify([{ state: "enrolled", n: 1 }]), `the registry reads ${JSON.stringify(await registry())}`);
    const carriedAgain = await bin("kernel-enrol", [...carryArgs, "--solicited", "--live"]);
    expect(
      carriedAgain.status === 0 && enrolled(carriedAgain.stdout) === 0 && /already enrolled in this sequence, by the registry/.test(carriedAgain.stdout),
      "a replayed enrolment from the list enrolled someone again, or was not answered from the registry",
    );
    const crossed = (
      await client.query(
        "select m.key, m.subject, m.body, m.unsolicited, e.state from relations.message m join acquisition.draft d on m.key = 'acquisition.draft:' || d.id join acquisition.enrolment e on e.person_id = d.person_id and e.sequence_key = 'follow-up'",
      )
    ).rows;
    expect(
      crossed.length === 1 && crossed[0].subject === "A subject" && crossed[0].body === "A first line." && crossed[0].unsolicited === false && crossed[0].state === "enrolled",
      `the database does not hold one message and its enrolment: ${JSON.stringify(crossed)}`,
    );
    // The way out (0067, 0069): the template's line, the sandbox's link in
    // it, written after the upload and read back — the provider's record,
    // not a message anyone received.
    const [held] = Object.values(JSON.parse(readFileSync(state, "utf8")).enrolments["follow-up"] ?? {});
    const line = `If you would rather not hear from me again, this link stops it: https://sandbox.invalid/stop/${held?.key}`;
    expect(
      JSON.stringify(held?.variables) === JSON.stringify({ engine_body_1: "A first line.", engine_subject_1: "A subject", engine_way_out: line }),
      `the sandbox holds ${JSON.stringify(held?.variables)}`,
    );
    const wayOut = (await client.query("select way_out, way_out_line, way_out_read_back_at is not null as read_back from acquisition.enrolment where sequence_key = 'follow-up'")).rows[0];
    expect(wayOut?.way_out === "written" && wayOut?.way_out_line === line && wayOut?.read_back === true, `the enrolment records its way out as ${JSON.stringify(wayOut)}`);
    expect(/way out: 1 written and read back at the provider, 0 cut/.test(carried.stdout), "kernel-enrol did not say the way out it wrote");
    expect(/way out: 1 would be written/.test(dry.stdout), "the dry run did not say the way out it would write");

    // The sandbox refuses the way out of a sequence its state file lists:
    // the person is enrolled, recorded without one, and the run says so.
    step("the enrolment whose way out cannot be written: enrolled, recorded absent, said aloud");
    const refusing = JSON.parse(readFileSync(state, "utf8"));
    writeFileSync(state, JSON.stringify({ ...refusing, wayOutRefused: ["refusing"] }));
    const without = await bin("kernel-enrol", ["--sequence", "refusing", ...carryArgs.slice(2), "--solicited", "--live"]);
    show(without);
    expect(without.status === 0 && enrolled(without.stdout) === 1, `kernel-enrol --sequence refusing: ${without.stdout.trim().split("\n").pop()}`);
    expect(/! 1 person enrolled without a way out: the line could not be written after the upload: unavailable: the sandbox refuses the way out of "refusing"/.test(without.stdout), "the run did not say aloud who went without a way out");
    const absent = (await client.query("select state, way_out, way_out_why from acquisition.enrolment where sequence_key = 'refusing'")).rows[0];
    expect(absent?.state === "enrolled" && absent?.way_out === "absent" && /the sandbox refuses/.test(absent?.way_out_why ?? ""), `the enrolment records ${JSON.stringify(absent)}`);

    // The one act that cannot be undone, on what the runs above really wrote:
    // Ada sourced, kept, listed and enrolled (0040, 0049).
    step("an erasure: planned, refused without a terminal, done at one, the runs' history kept naming nobody");
    const [{ id: adaId }] = (await client.query("select id from relations.person where lower(email) = 'ada@open.example.com'")).rows;
    const naming = async () => (await client.query("select count(*)::int as n from acquisition.sourcing_result where person::text ilike '%ada@open.example.com%' or person_id = $1", [adaId])).rows[0].n;
    const results = await count("acquisition.sourcing_result");
    expect((await naming()) > 1, "the sourcing runs above left fewer than two rows naming Ada: nothing would be reached by keys");
    const erasePlan = await bin("kernel-erase", ["--person", adaId, "--plan"]);
    show(erasePlan);
    expect(erasePlan.status === 0 && /sourcing_result: \d+ rows \(\d+ by keys\) — anonymise/.test(erasePlan.stdout), "kernel-erase --plan did not show the rows reached by keys");
    expect(/Not reached by this command \(decision 0049\)/.test(erasePlan.stdout) && /opt-out survives only as fingerprints in the register \(decision 0052\), one per key the erasure gathered: the one reader \(decision 0055\) finds the person objecting/.test(erasePlan.stdout), "kernel-erase --plan did not say what it does not reach");
    // Decision 0062: the plan says what the erasure would write in the register, under either answer.
    const wouldKeep = Number(erasePlan.stdout.match(/during erasure, relations: (\d+) entries it would write in the register, one per key, if the request includes not being contacted/)?.[1] ?? -1);
    expect(wouldKeep > 0, "the plan did not say what the erasure would keep of Ada's objection"); 
    // Decision 0056: the plan says what erasure would stop at the sequencer first, as dry runs.
    const heldNow = () => Object.entries(JSON.parse(readFileSync(state, "utf8")).enrolments ?? {}).filter(([, people]) => "ada@open.example.com" in people).map(([sequence]) => sequence);
    const adaHeld = heldNow();
    const adaRows = (await client.query("select count(*)::int as n from acquisition.enrolment where person_id = $1 and state = 'enrolled'", [adaId])).rows[0].n;
    expect(adaHeld.length > 0 && adaRows === adaHeld.length, `the sandbox holds Ada in [${adaHeld}] and the registry ${adaRows} rows: nothing to show erasure stops her`);
    expect(new RegExp(`before erasure, acquisition: ${adaRows} enrolments it would suspend, through the sequencer \\(sandbox-sequencer\\)`).test(erasePlan.stdout), "the plan did not say what erasure would stop at the sequencer");
    expect(heldNow().length === adaHeld.length, "the plan stopped someone: it is a dry run");
    const eraseBare = await bin("kernel-erase", ["--person", adaId, "--by", "an operator"]);
    expect(eraseBare.status === 1 && /at a terminal\. Nothing was changed/.test(eraseBare.stdout), `kernel-erase without a terminal: ${eraseBare.stdout.trim()}`);
    // Only yes or no answers the question (0052): an empty answer erases nobody.
    const unanswered = await typed("kernel-erase", ["--person", adaId, "--by", "an operator"], `${adaId}\n\n`);
    expect(unanswered.status === 1 && /only yes or no answers/.test(unanswered.stdout), `kernel-erase with no answer: ${unanswered.stdout.trim().split("\n").slice(-3).join(" / ")}`);
    expect((await count("relations.person where lower(email) = 'ada@open.example.com'")) === 1, "an unanswered question erased Ada");
    const erased = await typed("kernel-erase", ["--person", adaId, "--by", "an operator"], `${adaId}\nyes\n`);
    expect(erased.status === 0 && /erased; the person's row was deleted/.test(erased.stdout), `kernel-erase at a terminal: ${erased.stdout.trim().split("\n").slice(-8).join(" / ")}`);
    // Her objection, kept as one fingerprint per key under the version the
    // instance generated (0052, 0062), and nothing else.
    const kept = (await client.query("select count(*)::int as n from relations.suppression where chain = '{V1}' and run_id is not null")).rows[0].n;
    expect(kept === wouldKeep && (await count("relations.suppression")) === wouldKeep, `the register holds ${kept} entries under V1 for Ada, the plan said ${wouldKeep}`);
    // What lets the sequencer leave NOT_REACHED (0056), checked where it lives:
    // the sandbox no longer holds her, and every row of hers is suspended,
    // its read-back anonymised, naming nobody.
    expect(heldNow().length === 0, `the sandbox still holds Ada in [${heldNow()}] after her erasure`);
    const stopped = (await client.query(`select count(*)::int as n from acquisition.enrolment where state = 'suspended' and person_id is null and suspension_read_back = '{"erased": "decision 0053"}'::jsonb`)).rows[0].n;
    expect(stopped === adaRows, `${stopped} anonymised suspended rows, for ${adaRows} enrolments of Ada's`);
    expect(!/the sequencer: a person enrolled in a running sequence stays in it/.test(erased.stdout), "kernel-erase still says it does not reach the sequencer");
    expect((await count("relations.person where lower(email) = 'ada@open.example.com'")) === 0, "Ada is still on record");
    expect((await naming()) === 0, "a sourcing row still names Ada");
    expect((await count("acquisition.sourcing_result")) === results, "erasing deleted a run's history instead of anonymising it");

    // The provisional guard in `kernel-enrol`: once anyone is erased, and
    // until 0055's reader reads 0052's register, a live run is refused; a dry
    // run is not.
    step("enrol, after an erasure: refused live, a dry run still read");
    const runs = await count("core.run");
    const afterLive = await bin("kernel-enrol", [...carryArgs, "--solicited", "--live"]);
    show(afterLive);
    expect(afterLive.status === 1 && /an erasure has run on this instance/.test(afterLive.stdout), `kernel-enrol --live after an erasure: ${afterLive.stdout.trim()}`);
    expect((await count("core.run")) === runs, "the refused live run opened a run");
    const afterDry = await bin("kernel-enrol", [...carryArgs, "--solicited"]);
    expect(afterDry.status === 0 && /dry run/.test(afterDry.stdout), `kernel-enrol dry after an erasure: ${afterDry.stdout.trim()}`);
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
