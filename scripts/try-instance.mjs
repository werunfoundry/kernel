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
 *      a replay that enrols nobody twice; then `kernel-source`, dry and
 *      live, excluding by protection and by the CRM before and after
 *      completion; then `kernel-enrol --from-run` on what it kept, twice;
 *      then a person's acts (0047) — each refused without a terminal, shown
 *      on a dry run, and a list and a decision written through a
 *      pseudo-terminal. Every run is read back from the database.
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
    const registry = async () => (await client.query("select state, count(*)::int as n from acquisition.enrolment group by 1 order by 1")).rows;
    const skipsOf = async (out) => {
      const id = out.match(/^run: ([0-9a-f-]{36})/m)?.[1];
      return id ? (await client.query("select reason, count(*)::int as n from acquisition.enrolment_skip where run_id = $1 group by 1 order by 1", [id])).rows : [];
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

    // The bridge: enrolment reads the people that run kept — Ada — and no one
    // else, in a sequence of its own; a second consumption enrols nobody.
    const sourcingRun = sourcedLive.stdout.match(/^run: ([0-9a-f-]{36})/m)?.[1] ?? "";
    const fromArgs = ["--sequence", "sourced", "--channel", "email", "--max-age", "60", "--from-run", sourcingRun];

    step("enrol from the sourcing run, live");
    const fromLive = await bin("kernel-enrol", [...fromArgs, "--live"]);
    show(fromLive);
    expect(fromLive.status === 0, `enrolling from the sourcing run exited ${fromLive.status}`);
    expect(enrolled(fromLive.stdout) === 1 && /\+ ada@open\.example\.com/.test(fromLive.stdout), "enrolling from the sourcing run did not enrol Ada alone");

    step("enrol from the sourcing run, again");
    const fromAgain = await bin("kernel-enrol", [...fromArgs, "--live"]);
    show(fromAgain);
    expect(enrolled(fromAgain.stdout) === 0, "a sourcing run consumed twice enrolled someone twice");
    expect(/already enrolled in this sequence, by the registry/.test(fromAgain.stdout), "the second consumption was not caught by the registry");

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

    // The sending path (0050), from the packs, on plain Node: the list just
    // constituted, drafted, approved, sent through the message's gate and
    // recorded as a touch. The hand-over is a stub written here: the kernel
    // ships none, and nothing in this step reaches a provider.
    step("the sending path, from the list, with a stub hand-over");
    const experimentId = (await client.query("insert into core.experiment (slug, type, hypothesis_ref, lane, status) values ('try-send', 'campaign', 'https://example.com/h', 'reviewed', 'running') returning id")).rows[0].id;
    const templateId = (await client.query("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'A first line.') returning id", [experimentId])).rows[0].id;
    const sendScript = `
      import { boot } from "@werunfoundry/core/runtime/boot";
      import { connect } from "@werunfoundry/core/runtime/connect";
      import { approve } from "@werunfoundry/acquisition/runtime/draft";
      import { draftFromList, sendFromList } from "@werunfoundry/acquisition/runtime/send";
      const root = process.cwd();
      const booted = await boot({ root, env: process.env });
      if (!booted.ok) throw new Error("boot refused: " + booted.issues.map((i) => i.message).join("; "));
      const { db, end } = await connect(process.env.DATABASE_URL, root, "try-send");
      const handed = [];
      const stub = { provider: "stub-handover", async handOver(m) { handed.push(m.idempotencyKey); return { ok: true, value: { providerEventId: "stub:" + m.idempotencyKey, at: new Date().toISOString() } }; } };
      const actor = { type: "agent", id: "a drafting agent" };
      const drafted = await draftFromList(db, { listKey: "sourced", experimentId: ${JSON.stringify(experimentId)}, templateId: ${JSON.stringify(templateId)}, compose: (_p, t) => ({ body: t.body }), gate: { autonomyAfter: 5 }, dryRun: false, trigger: "cli", actor });
      for (const d of drafted.drafted) await approve(db, d.draftId, { by: "an operator" }, { actor: { type: "human", id: "an operator" } });
      const request = { listKey: "sourced", experimentId: ${JSON.stringify(experimentId)}, unsolicited: true, cap: { max: 1, withinDays: 30 }, protectedMaxAgeMinutes: 60, dryRun: false, trigger: "cli", actor: { type: "system", id: "try-instance" } };
      const sent = await sendFromList({ db, registry: booted.registry, handOver: stub }, request);
      const again = await sendFromList({ db, registry: booted.registry, handOver: stub }, request);
      await end();
      console.log(JSON.stringify({ drafted: drafted.drafted.map((d) => d.outcome), sent: sent.drafts.map((d) => d.outcome), again: again.drafts.length, handed: handed.length }));
    `;
    const sending = await spawnAsync(process.execPath, ["--input-type=module", "-e", sendScript], { cwd: root, env });
    show(sending);
    expect(sending.status === 0, "the sending path did not run from the packs");
    const said = JSON.parse(sending.stdout.trim().split("\n").pop() || "{}");
    expect(JSON.stringify(said) === JSON.stringify({ drafted: ["awaiting_review"], sent: ["sent"], again: 0, handed: 1 }), `the sending path reported ${JSON.stringify(said)}`);
    const crossed = (
      await client.query(
        "select m.key, t.direction, t.unsolicited, t.provider, d.state from relations.message m join relations.touch t on t.message_id = m.id join acquisition.draft d on m.key = 'acquisition.draft:' || d.id",
      )
    ).rows;
    expect(
      crossed.length === 1 && crossed[0].direction === "outbound" && crossed[0].unsolicited === true && crossed[0].provider === "stub-handover" && crossed[0].state === "sent",
      `the database does not hold one message, its touch and a sent draft: ${JSON.stringify(crossed)}`,
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
