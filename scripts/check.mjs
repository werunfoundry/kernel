#!/usr/bin/env node
/**
 * Doctrine checks. No dependencies, Node 20+.
 *
 *   node scripts/check.mjs            all tracked files
 *   node scripts/check.mjs --staged   staged files only (used by the pre-commit hook)
 *
 * Every check here maps to a numbered rule in DOCTRINE.md. A check that cannot
 * name its rule does not belong in this file.
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { posix } from "node:path";

const staged = process.argv.includes("--staged");
const messageAt = process.argv.indexOf("--message");

const list = staged
  ? "git diff --cached --name-only --diff-filter=ACMR"
  : "git ls-files --cached --others --exclude-standard";

function listFiles(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // A gate that answers a git problem with a stack trace is a gate people
    // stop reading. Say what happened, in one line, and exit distinctly.
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0];
    console.error(`doctrine: cannot list the files to check — ${detail}`);
    process.exit(2);
  }
}

const files = listFiles(list)
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false; // deleted in this commit
    }
  });

/**
 * Two listings, and the difference matters.
 *
 * Content checks — secrets, fixtures, provider names — look at what is being
 * committed, so in `--staged` mode they see the staged files only.
 *
 * Structural checks — which layer depends on which, where an adapter lives,
 * whether a domain declares itself — are about the repository as a whole. Run
 * on a partial listing they report that `domains/x` has no `domain.yaml`
 * whenever a commit happens not to touch that file, which is almost every
 * commit. A gate that fires on correct work is a gate that gets bypassed.
 */
const allFiles = staged
  ? listFiles("git ls-files --cached --others --exclude-standard")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      })
  : files;

const failures = [];
const fail = (rule, file, line, msg) =>
  failures.push({ rule, file, line, msg });

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|txt|csv|env|sh)$/i;
const isText = (f) => TEXT.test(f) || !f.includes(".");

/* -- Rule 7: no secret, ever ------------------------------------------- */

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API key (sk-)"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]{6,}@/, "connection string with password"],
];

/* -- Rule 7: a commit message is as permanent as a file ----------------- */

/**
 * A commit message cannot be edited after it is pushed. Anything in it —
 * a token pasted into a description, a link to internal tooling, a client
 * name in a "fixes X for Y" — is published on the same terms as the code,
 * and is not covered by any check that looks at files.
 */
const PRIVATE_IN_MESSAGE = [
  [/\bclaude\.ai\/[^\s)]+/i, "a link to a private assistant session"],
  [/\bchatgpt\.com\/[^\s)]+/i, "a link to a private assistant session"],
  [/\bsession[_-][A-Za-z0-9]{12,}/, "an internal session identifier"],
];

if (messageAt !== -1) {
  const file = process.argv[messageAt + 1];
  const body = readFileSync(file, "utf8");
  const problems = [];
  body.split("\n").forEach((text, i) => {
    if (text.startsWith("#")) return; // git's own comments, never committed
    for (const [re, what] of [...SECRETS, ...PRIVATE_IN_MESSAGE]) {
      const hit = text.match(re);
      if (hit) problems.push(`  line ${i + 1}: ${what} — ${hit[0].slice(0, 60)}`);
    }
  });
  if (problems.length === 0) process.exit(0);
  console.error("\ndoctrine 7: this commit message would be published as written\n");
  console.error(problems.join("\n"));
  console.error("\nA pushed commit message cannot be edited. Remove it and commit again.\n");
  process.exit(1);
}

// Tracked *and* not-yet-tracked files. A check that only sees the index is
// blind in a repository whose first commit has not happened yet.
/* -- Rule 7: fixtures are invented -------------------------------------- */

const IS_FIXTURE = /(^|\/)(fixtures?|__fixtures__|seed|seeds)(\/|$)/i;
const ALLOWED_DOMAIN = /@(example\.(com|org|net)|[a-z0-9-]+\.invalid)\b/i;
const ANY_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const REAL_PROFILE = /(linkedin\.com|twitter\.com|x\.com)\/(in|company)\//i;

/* -- Rules 1 and 6: no provider named outside its adapter --------------- */

// Bounded by anything that is not a letter or a digit, not by \b: \b counts
// "_" as a letter, which let `linkedin_profile_id` or `hubspot_id` through —
// the exact shape a provider name takes when it slips into an identifier.
const PROVIDERS =
  /(?<![a-z0-9])(instantly|lemlist|attio|pipedrive|hubspot|salesforce|customer\.?io|apollo|clay|smartlead|linkedin|bigquery)(?![a-z0-9])/i;
// Every file in the repository, except an adapter. Covering only the engine's
// code left decisions/, the README and the template open, and a decision is
// exactly where a provider gets named while explaining it.
const IS_ADAPTER = /(^|\/)adapters?\//;
// The two files that hold the list above. By exact path: a pattern here would
// be a second way to switch the check off, and the tests pin that it is not.
const PROVIDER_LIST_HOMES = new Set(["scripts/check.mjs", "scripts/check.test.mjs"]);
/**
 * Where a line can be prose explaining why a provider must not be named, and
 * how such a line starts. Only comments in code and configuration: in
 * Markdown, `#` is a heading and `*` a list item, and exempting them would let
 * a decision title name a provider.
 */
function commentIn(file) {
  if (/\.(ts|tsx|js|mjs|cjs)$/i.test(file)) return /^\s*(\*|\/\/)/;
  if (/\.(ya?ml|sh)$/i.test(file)) return /^\s*#/;
  return null;
}

/* -- Rule 7: every file is text the checks can read --------------------- */

/**
 * The secret, fixture and provider checks read text. A file that is not text
 * is not refused by them; it is unseen. An archive of the working tree is the shape this takes:
 * the tree it packs holds a real `.env` next to `.env.example`, and a tarball
 * carries one as readily as the other, compressed into bytes no pattern here
 * matches. One was committed at the root of this repository, and only the way
 * it happened to be made kept the `.env` out of it.
 *
 * `.gitignore` lists archives too, but it is a courtesy, not a gate: `git add
 * -f`, or a name it does not cover, walks past it. This repository is text
 * from end to end, so the rule is about content, not names: every file must
 * decode as UTF-8 and hold no NUL byte. The NUL matters — an uncompressed tar
 * of text files is valid UTF-8, its headers padded with NULs, and its members
 * readable to anyone who downloads it.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function notText(file) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    return null; // unreadable here; the listing already dropped what is gone
  }
  if (bytes.includes(0)) return "holds a NUL byte";
  try {
    UTF8.decode(bytes);
  } catch {
    return "is not valid UTF-8";
  }
  return null;
}

/* -- Rule 8: an instance holds no engine code --------------------------- */

const TEMPLATE_CODE = /^template\/(context|manifest)\/.*\.(ts|js|mjs)$/;

for (const file of files) {
  if (/^\.env($|\.)/.test(file) && file !== ".env.example") {
    fail(7, file, 0, "an .env file must never be committed");
    continue;
  }
  if (TEMPLATE_CODE.test(file)) {
    fail(8, file, 0, "an instance carries configuration and context, not code");
  }
  const binary = notText(file);
  if (binary) {
    fail(7, file, 0, `${binary}: no check here can read what it carries, so none can say it carries no secret`);
    continue;
  }
  if (!isText(file)) continue;

  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  if (file.endsWith(".json")) {
    try {
      JSON.parse(body);
    } catch (error) {
      fail(6, file, 0, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const lines = body.split("\n");
  const fixture = IS_FIXTURE.test(file);
  const providerFree = !IS_ADAPTER.test(file) && !PROVIDER_LIST_HOMES.has(file);
  const comment = commentIn(file);

  lines.forEach((text, i) => {
    const n = i + 1;

    for (const [re, what] of SECRETS) {
      if (re.test(text)) fail(7, file, n, `looks like a ${what}`);
    }

    if (fixture) {
      for (const email of text.match(ANY_EMAIL) ?? []) {
        if (!ALLOWED_DOMAIN.test(email)) {
          fail(7, file, n, `fixture uses a real-looking address: ${email}`);
        }
      }
      if (REAL_PROFILE.test(text)) {
        fail(7, file, n, "fixture uses a real profile or company URL");
      }
    }

    if (providerFree) {
      const hit = text.match(PROVIDERS);
      // A provider may be named in prose that explains why it must not be.
      if (hit && !(comment && comment.test(text))) {
        fail(1, file, n, `provider named outside an adapter: ${hit[0]}`);
      }
    }
  });
}

/* -- Rule 2: dependencies point down, never sideways -------------------- */

/**
 * Turns rule 2 into a constraint instead of a convention.
 *
 * Each layer declares what it depends on in its `domain.yaml`. This reads the
 * declaration, then reads what the code actually imports and what its foreign
 * keys actually point at, and fails on the difference. `core` is implicit: it
 * is the bottom, everyone may depend on it, and it may depend on no one.
 */

const PKG = "@werunfoundry";

/** A deliberately small YAML reader: scalars and one list, nothing else. */
function readDomainYaml(file) {
  const out = { name: "", schema: "", dependsOn: [] };
  let inList = false;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.+)$/);
    if (inList && item) {
      out.dependsOn.push(item[1].trim());
      continue;
    }
    inList = false;
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "dependsOn") {
      if (value.trim() === "" ) inList = true;
      else if (value.trim() !== "[]") out.dependsOn.push(value.trim());
    } else if (key === "name" || key === "schema") {
      out[key] = value.trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const IMPORTS = /import\s+(?:type\s+)?(?:\{([\s\S]*?)\}|[\w*\s,]+?)\s*from\s*["']([^"']+)["']/g;
const FOREIGN_KEY = /references\(\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)/g;

function layerOf(file) {
  if (file.startsWith("core/")) return "core";
  const m = file.match(/^domains\/([^/]+)\//);
  return m ? m[1] : null;
}

const layers = new Map([["core", { dependsOn: [], schema: "core" }]]);
for (const file of allFiles) {
  if (!/^domains\/[^/]+\/domain\.yaml$/.test(file)) continue;
  const declared = readDomainYaml(file);
  const dir = file.split("/")[1];
  if (declared.name !== dir) {
    fail(2, file, 0, `declares name "${declared.name}" but lives in domains/${dir}`);
  }
  layers.set(dir, declared);
}

/**
 * An instance finds a domain by its package name and reads its `domain.yaml`
 * through the package's exports (decision 0007). A domain whose package is
 * misnamed, or that does not export the file, passes every other check here
 * and cannot be enabled by anyone — which is learned at the first boot of the
 * first instance that tries, in someone else's repository.
 */
/*
 * The workspace reads `exports`; what is published reads `publishConfig.exports`
 * (decision 0006). Two lists of the same paths drift the first time someone
 * adds an export and forgets the second list — and the workspace, which never
 * reads the published one, stays green while every instance breaks.
 */
// The adapters package is published like a layer and is not one: the same
// two lists, and no domain.yaml to export (decision 0023).
const packages = [...layers.keys()].map((name) => [name, name === "core" ? "core/package.json" : `domains/${name}/package.json`]);
if (allFiles.includes("adapters/package.json")) packages.push(["adapters", "adapters/package.json"]);

for (const [name, file] of packages) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(6, file, 0, "a layer is a package; without a readable package.json no instance can install it");
    continue;
  }

  const here = Object.keys(pkg.exports ?? {}).sort().join(", ");
  const published = Object.keys(pkg.publishConfig?.exports ?? {}).sort().join(", ");
  if (here !== published) {
    fail(6, file, 0, `exports and publishConfig.exports list different paths — published: [${published}], here: [${here}]`);
  }
  const bins = Object.keys(pkg.bin ?? {}).sort().join(", ");
  const publishedBins = Object.keys(pkg.publishConfig?.bin ?? pkg.bin ?? {}).sort().join(", ");
  if (bins !== publishedBins) {
    fail(6, file, 0, `bin and publishConfig.bin list different commands — published: [${publishedBins}], here: [${bins}]`);
  }
  for (const [command, target] of Object.entries(pkg.publishConfig?.bin ?? {})) {
    if (typeof target === "string" && target.endsWith(".ts")) {
      fail(6, file, 0, `publishes the command "${command}" as TypeScript source, which Node refuses under node_modules (decision 0006)`);
    }
  }
  for (const [path, target] of Object.entries(pkg.publishConfig?.exports ?? {})) {
    const targets = typeof target === "string" ? [target] : Object.values(target ?? {});
    if (targets.some((t) => typeof t === "string" && t.endsWith(".ts") && !t.endsWith(".d.ts"))) {
      fail(6, file, 0, `publishes "${path}" as TypeScript source, which Node refuses under node_modules (decision 0006)`);
    }
  }

  if (name === "core" || name === "adapters") continue;
  if (pkg.name !== `${PKG}/${name}`) {
    fail(6, file, 0, `is named "${pkg.name}"; an instance looks for this domain as "${PKG}/${name}"`);
  }
  if (pkg.exports?.["./domain.yaml"] !== "./domain.yaml") {
    fail(6, file, 0, 'does not export "./domain.yaml": "./domain.yaml", so boot cannot read it (decision 0007)');
  }
}

for (const [name, layer] of layers) {
  for (const dep of layer.dependsOn) {
    if (!layers.has(dep)) {
      fail(2, `domains/${name}/domain.yaml`, 0, `depends on "${dep}", which is not a domain here`);
    }
  }
}

for (const file of allFiles) {
  if (!/\.ts$/.test(file)) continue;
  const self = layerOf(file);
  if (self === null) continue;
  const layer = layers.get(self);
  if (!layer) continue;

  const allowed = new Set(["core", self, ...layer.dependsOn]);
  const body = readFileSync(file, "utf8");

  /** identifier -> the layer it came from, for the foreign-key pass. */
  const origin = new Map();

  for (const match of body.matchAll(IMPORTS)) {
    const [, named, specifier] = match;
    if (!specifier.startsWith(`${PKG}/`)) continue;
    const from = specifier.slice(PKG.length + 1).split("/")[0];
    if (!allowed.has(from)) {
      const how = self === "core"
        ? "core is the bottom layer and depends on nothing"
        : `domains/${self}/domain.yaml does not declare "${from}"`;
      fail(2, file, lineAt(body, match.index), `imports from ${PKG}/${from}: ${how}`);
    }
    for (const id of (named ?? "").split(",")) {
      const clean = id.replace(/^\s*type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (clean) origin.set(clean, from);
    }
  }

  for (const match of body.matchAll(FOREIGN_KEY)) {
    const target = match[1];
    const from = origin.get(target) ?? self;
    if (allowed.has(from)) continue;
    fail(2, file, lineAt(body, match.index), `foreign key points at ${from}.${target}, which is not a declared dependency`);
  }
}

function lineAt(body, index) {
  return body.slice(0, index).split("\n").length;
}

/* -- Rules 2 and 6: a rule can only hold where it can see ---------------- */

/**
 * Three places where a misplaced file does not break a rule so much as switch
 * it off. These are not layout preferences — a check that encodes taste gets
 * bypassed, and takes every other check with it when it goes.
 *
 *   1. The provider check exempts anything under `adapters/`. If an `adapters/`
 *      may appear anywhere, the exemption is a way to turn the check off.
 *   2. The dependency check reads the schema files it knows where to find. A
 *      schema declared somewhere else is not refused; it is unseen, foreign
 *      keys and all.
 *   3. Both assume `domains/<name>/`. A domain nested inside a domain, or a
 *      folder with no `domain.yaml`, breaks that assumption quietly.
 */

const ADAPTER_SEGMENT = /(^|\/)adapters?\//;
// Two homes, for two different repositories. `adapters/<provider>/` holds the
// adapters this repository ships, one folder per provider whichever domains
// own the contracts it satisfies (decision 0023); `template/adapters/` is the
// skeleton an instance is generated from, where an instance keeps its own
// (decision 0005). Anywhere else, the exemption above would be a way to
// switch the provider check off. At the root of `adapters/` only the
// package's own files sit: code there belongs to no provider.
const ADAPTER_HOME = /^(adapters\/[^/]+\/|template\/adapters\/|adapters\/(package\.json|tsconfig(\.build)?\.json|README\.md)$)/;
const SCHEMA_HOME = /^(core|domains\/[^/]+)\/db\/schema\.ts$/;

const domainFolders = new Set();

for (const file of allFiles) {
  if (ADAPTER_SEGMENT.test(file) && !ADAPTER_HOME.test(file)) {
    fail(6, file, 0, "an adapter lives in adapters/<provider>/ or template/adapters/, nowhere else");
  }

  const inDomain = file.match(/^domains\/([^/]+)\//);
  if (inDomain) {
    domainFolders.add(inDomain[1]);
    if (/(^|\/)domains\//.test(file.slice(`domains/${inDomain[1]}/`.length))) {
      fail(2, file, 0, "a domain does not contain domains; layers are flat");
    }
  } else if (/^domains\/[^/]+$/.test(file)) {
    fail(2, file, 0, "domains/ holds domain folders, not files");
  }

  if (!/\.ts$/.test(file) || SCHEMA_HOME.test(file)) continue;
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (/\bpgSchema\s*\(/.test(body)) {
    fail(2, file, lineAt(body, body.search(/\bpgSchema\s*\(/)),
      "a schema declared here is invisible to the dependency check; it belongs in <layer>/db/schema.ts");
  }
}

for (const folder of [...domainFolders].sort()) {
  if (!layers.has(folder)) {
    fail(2, `domains/${folder}`, 0, "no domain.yaml: this folder declares nothing, so nothing about it is checked");
  }
}

/* -- Rule 6: an adapter sees contracts, and nothing else of the engine ---- */

/**
 * An adapter satisfies contracts. It may import the contracts of any domain —
 * that is what lets one provider's folder serve two sibling domains, which no
 * single domain sees (decision 0023) — and nothing else the engine has: not a
 * schema, not the runtime, not a manifest, not another adapter. An adapter
 * that reaches the database or the enrolment path is a domain written in the
 * wrong place.
 *
 * `@werunfoundry/core/identity` is part of that surface, not an exception to
 * it: every contract that names a person or a company is written in its
 * types (decision 0013).
 *
 * The rule-2 pass above reads static imports only, and only in layers, so this
 * one reads every form a module can be named in — `import … from`,
 * `export … from`, a bare `import "x"`, `import(…)`, `require(…)` — and
 * refuses a dynamic one whose argument is not a literal, which no check can
 * read. A relative import must stay in the adapter's own folder: `../../`
 * would otherwise reach a schema without ever naming a package. And a
 * database client is refused by name, because it reaches the database without
 * importing anything of ours.
 */

const ADAPTER_CODE = /^(adapters\/([^/]+)\/|template\/adapters\/).*\.(ts|tsx|js|mjs|cjs)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])([^"']+)\1/gm;
const UNREADABLE = /\b(?:import|require)\s*\(\s*(?!["'])(?!\))/g;
const DATABASE_CLIENT = /^(pg|postgres|drizzle-orm|drizzle-kit)(\/|$)/;
const CONTRACT_PATH = /^(contracts)(\/[a-z0-9-]+)*$/;

function adapterMayImport(specifier) {
  const [layer, ...rest] = specifier.slice(PKG.length + 1).split("/");
  const path = rest.join("/");
  if (!layers.has(layer)) return false;
  if (CONTRACT_PATH.test(path)) return true;
  return layer === "core" && path === "identity";
}

for (const file of allFiles) {
  const at = file.match(ADAPTER_CODE);
  if (!at) continue;
  // Its own folder: one provider's, or the template's flat one.
  const home = at[2] ? `adapters/${at[2]}/` : "template/adapters/";
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = body.split("\n");
  const prose = (index) => /^\s*(\*|\/\/)/.test(lines[lineAt(body, index) - 1] ?? "");

  for (const match of body.matchAll(SPECIFIER)) {
    if (prose(match.index)) continue;
    const specifier = match[2];
    const line = lineAt(body, match.index);
    if (specifier.startsWith(".")) {
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!target.startsWith(home)) {
        fail(6, file, line, `imports ${specifier}, outside ${home}: an adapter reaches the engine through its contracts only`);
      }
    } else if (specifier.startsWith(`${PKG}/`)) {
      if (!adapterMayImport(specifier)) {
        fail(6, file, line, `imports ${specifier}: an adapter may import a domain's contracts and nothing else of the engine (decision 0023)`);
      }
    } else if (DATABASE_CLIENT.test(specifier)) {
      fail(6, file, line, `imports ${specifier}: an adapter never reaches the database; the engine owns persistence`);
    }
  }
  for (const match of body.matchAll(UNREADABLE)) {
    if (prose(match.index)) continue;
    fail(6, file, lineAt(body, match.index), "loads a module this check cannot read; name it with a string literal");
  }
}

/* -- Rule 6: a decision's cross-references hold (decision 0059) ---------- */

/**
 * Two rules that discipline alone let rot: fourteen pointers were missing
 * across ten decisions written in two days, and seven citations by line
 * moved the day a pointer was added above them.
 *
 * A citation of a decision by line — `0052:130` — is refused anywhere under
 * decisions/. A pointer added above a line moves it, so every pointer the
 * convention asks for breaks every line cited below it. A decision is cited
 * by its section and its sentence; code by file and symbol, or by line at a
 * named commit, which `erase.ts:60` does not match.
 *
 * And a decision whose introduction says it completes, supersedes or
 * reverses another — the text between its title, with the notes under it,
 * and its first section — finds a pointer back to it in that other
 * decision, under its title. In a sentence, a number belongs to the last of
 * those verbs before it; "rests on" is how an introduction names a decision
 * it builds on without changing it. Whether the pointer's form is right is
 * not read: a decision that completes another may reverse part of it, and
 * only a reader can tell.
 */
const DECISION = /^decisions\/(\d{4})-[^/]*\.md$/;
const LINE_CITATION = /(?<![\w./-])\d{4}:\d+/g;
const POINTER = /^> (?:Superseded by|Superseded in part by|Completed by) \[(\d{4})\]/;
const VERB = /\b(Completes|Supersedes|Reverses|rests on)\b|\b(\d{4})\b/g;

/** The lines under the title that are notes and pointers, and the introduction after them. */
function decisionParts(body) {
  const lines = body.split("\n");
  let i = 1;
  while (i < lines.length && (lines[i].startsWith(">") || lines[i].trim() === "")) i++;
  let end = i;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return { head: lines.slice(1, i), intro: lines.slice(i, end).join("\n"), introAt: i + 1 };
}

for (const file of files) {
  if (!DECISION.test(file)) continue;
  const body = readFileSync(file, "utf8");
  for (const match of body.matchAll(LINE_CITATION)) {
    fail(6, file, lineAt(body, match.index), `cites a decision by line, ${match[0]}: a pointer added above that line moves it; cite its section and its sentence (decision 0059)`);
  }
}

const decisions = new Map();
for (const file of allFiles) {
  const m = file.match(DECISION);
  if (m) decisions.set(m[1], { file, ...decisionParts(readFileSync(file, "utf8")) });
}
/** What an introduction says it completes, supersedes or reverses. */
function declaredBy(intro) {
  const declared = new Set();
  for (const sentence of intro.split(/\.(?=\s|$)/)) {
    let verb = null;
    for (const m of sentence.matchAll(VERB)) {
      if (m[1]) verb = m[1];
      else if (verb && verb !== "rests on") declared.add(m[2]);
    }
  }
  return declared;
}

for (const [number, { file, intro, introAt }] of decisions) {
  for (const other of [...declaredBy(intro)].sort()) {
    const target = decisions.get(other);
    if (!target || other >= number) continue;
    const back = target.head.some((l) => l.match(POINTER)?.[1] === number);
    if (!back) {
      fail(6, file, introAt, `says it completes, supersedes or reverses ${other}, and ${target.file} carries no pointer to ${number} under its title (decision 0059)`);
    }
  }
}

/**
 * The other way (decision 0061): a pointer is backed by the introduction of
 * the decision it names. A pointer left after an introduction was rewritten,
 * or put under the wrong decision, otherwise passes: reading the body would
 * not catch it, since a decision names in its body the ones it only reads.
 *
 * Only for decisions written once the introduction was the form, which 0059
 * made it. Before it, an introduction was prose, or absent: 0046 renames a
 * domain for seventeen decisions it never names, 0012 has no introduction,
 * and both are right. Those pointers are not checked, and never will be.
 * A pointer naming a decision that does not exist is refused whatever its age.
 */
const INTRODUCTION_IS_THE_FORM_FROM = "0059";
for (const [number, { file, head }] of decisions) {
  head.forEach((line, i) => {
    const source = line.match(POINTER)?.[1];
    if (!source) return;
    const from = decisions.get(source);
    if (!from) {
      fail(6, file, i + 2, `points to ${source}, which is not a decision here (decision 0061)`);
    } else if (source >= INTRODUCTION_IS_THE_FORM_FROM && !declaredBy(from.intro).has(number)) {
      fail(6, file, i + 2, `carries a pointer to ${source}, whose introduction does not say it completes, supersedes or reverses ${number} (decision 0061)`);
    }
  });
}

if (failures.length === 0) {
  console.log(`doctrine: ok (${files.length} files)`);
  process.exit(0);
}

console.error(`\ndoctrine: ${failures.length} problem(s)\n`);
for (const f of failures) {
  const at = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`  rule ${f.rule}  ${at}\n            ${f.msg}`);
}
console.error("\nDOCTRINE.md explains each rule.\n");
process.exit(1);
