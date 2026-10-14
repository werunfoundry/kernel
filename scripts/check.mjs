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

const staged = process.argv.includes("--staged");

// Tracked *and* not-yet-tracked files. A check that only sees the index is
// blind in a repository whose first commit has not happened yet.
const list = staged
  ? "git diff --cached --name-only --diff-filter=ACMR"
  : "git ls-files --cached --others --exclude-standard";

const files = execSync(list, { encoding: "utf8" })
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

/* -- Rule 7: fixtures are invented -------------------------------------- */

const IS_FIXTURE = /(^|\/)(fixtures?|__fixtures__|seed|seeds)(\/|$)/i;
const ALLOWED_DOMAIN = /@(example\.(com|org|net)|[a-z0-9-]+\.invalid)\b/i;
const ANY_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const REAL_PROFILE = /(linkedin\.com|twitter\.com|x\.com)\/(in|company)\//i;

/* -- Rules 1 and 6: no provider named outside its adapter --------------- */

const PROVIDERS =
  /\b(instantly|lemlist|attio|pipedrive|hubspot|salesforce|customer\.?io|apollo|clay|smartlead)\b/i;
// Everything in the engine, except an adapter. Naming the directories that
// are covered would leave every directory added later uncovered.
const PROVIDER_FREE = /^(core|domains)\//;
const IS_ADAPTER = /(^|\/)adapters?\//;

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
  if (!isText(file)) continue;

  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (body.includes("\u0000")) continue; // binary

  const lines = body.split("\n");
  const fixture = IS_FIXTURE.test(file);
  const providerFree = PROVIDER_FREE.test(file) && !IS_ADAPTER.test(file);

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
      if (hit && !/^\s*(\*|\/\/|#)/.test(text)) {
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
for (const file of files) {
  if (!/^domains\/[^/]+\/domain\.yaml$/.test(file)) continue;
  const declared = readDomainYaml(file);
  const dir = file.split("/")[1];
  if (declared.name !== dir) {
    fail(2, file, 0, `declares name "${declared.name}" but lives in domains/${dir}`);
  }
  layers.set(dir, declared);
}

for (const [name, layer] of layers) {
  for (const dep of layer.dependsOn) {
    if (!layers.has(dep)) {
      fail(2, `domains/${name}/domain.yaml`, 0, `depends on "${dep}", which is not a domain here`);
    }
  }
}

for (const file of files) {
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
const ADAPTER_HOME = /^domains\/[^/]+\/adapters\//;
const SCHEMA_HOME = /^(core|domains\/[^/]+)\/db\/schema\.ts$/;

const domainFolders = new Set();

for (const file of files) {
  if (ADAPTER_SEGMENT.test(file) && !ADAPTER_HOME.test(file)) {
    fail(6, file, 0, "an adapter lives in domains/<name>/adapters/ and nowhere else");
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
