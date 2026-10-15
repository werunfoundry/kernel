#!/usr/bin/env node
/**
 * The check an instance runs on itself.
 *
 * It ships from the engine rather than being copied into each instance, so
 * that a rule learned the hard way in one of them reaches the others through
 * a version bump instead of a paste nobody repeats.
 *
 * It guards the *shape* of an instance repository. What is inside the manifest
 * — whether a domain's dependency is enabled, whether a contract is bound
 * twice — is validated by the engine at startup, where the manifest is parsed
 * anyway. This runs before anything is installed and needs no dependencies.
 *
 *   npx kernel-check-instance
 */

import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const failures = [];
const fail = (file, line, msg) => failures.push({ file, line, msg });

let files;
try {
  files = execSync("git ls-files --cached --others --exclude-standard", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const detail = String(error?.stderr ?? error?.message ?? error).trim().split("\n")[0];
  console.error(`instance: cannot list the files to check — ${detail}`);
  process.exit(2);
}

const tracked = files
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });

/* -- Doctrine 7: no secret, ever ---------------------------------------- */

const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API key (sk-)"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@]{6,}@/, "connection string with password"],
];

/* -- Doctrine 8: an instance holds adapters, and nothing else that is code */

const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const IN_ADAPTERS = /^adapters\//;
/** Entry points an instance is allowed to have, beyond its adapters. */
const ALLOWED_CODE = /^(adapters\/|scripts\/|drizzle\.config\.ts$)/;

/** An adapter that reaches into the database is a domain in the wrong repo. */
const TOUCHES_DB = [
  [/@werunfoundry\/[a-z]+\/db\/schema/, "imports a schema; the engine owns what is persisted"],
  [/\bpgSchema\s*\(/, "declares a schema; an instance never adds tables"],
  [/\bprocess\.env\b/, "reads the environment directly; it receives the variables its binding declared"],
];

const TEXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sql|md|txt|env|sh)$/i;

for (const file of tracked) {
  if (/^\.env($|\.)/.test(file) && file !== ".env.example") {
    fail(file, 0, "an .env file must never be committed");
    continue;
  }

  if (CODE.test(file) && !ALLOWED_CODE.test(file)) {
    fail(file, 0, "an instance holds adapters, not code — this belongs in adapters/, or in the engine");
  }

  if (!TEXT.test(file)) continue;

  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (body.includes("\u0000")) continue;

  if (file.endsWith(".json")) {
    try {
      JSON.parse(body);
    } catch (error) {
      fail(file, 0, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  body.split("\n").forEach((text, i) => {
    const n = i + 1;
    for (const [re, what] of SECRETS) {
      if (re.test(text)) fail(file, n, `looks like a ${what}`);
    }
    if (IN_ADAPTERS.test(file) && CODE.test(file)) {
      for (const [re, why] of TOUCHES_DB) {
        if (re.test(text) && !/^\s*(\*|\/\/|#)/.test(text)) fail(file, n, why);
      }
    }
  });
}

/* -- Decision 0025: the engine is consumed as published, never as a folder */

/**
 * A dependency on the engine names a version or a packed tarball. A folder —
 * `file:../kernel/core`, `link:`, `portal:`, `workspace:` — installs what the
 * workspace sees, not what is published: `exports` pointing at TypeScript
 * that is not installed, commands Node refuses to run under node_modules,
 * and `workspace:*` dependencies that mean nothing here. It fails at the
 * first command, far from the line that caused it; this says so at the line.
 */
const ENGINE = /^@werunfoundry\//;
const FOLDER = /^(link:|portal:|workspace:)|^file:(?!.*\.tgz$)/;

function refuseFolders(file, entries) {
  for (const [name, spec] of entries) {
    if (ENGINE.test(name) && typeof spec === "string" && FOLDER.test(spec)) {
      fail(file, 0, `${name} is "${spec}": the engine is consumed as a published version or a packed tarball, never a folder (decision 0025)`);
    }
  }
}

if (tracked.includes("package.json")) {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides"]) {
      refuseFolders("package.json", Object.entries(pkg[field] ?? {}));
    }
    refuseFolders("package.json", Object.entries(pkg.pnpm?.overrides ?? {}));
  } catch {
    /* an unparsable package.json is reported above */
  }
}
if (tracked.includes("pnpm-workspace.yaml")) {
  // One entry per line, `"@werunfoundry/x": "spec"` or unquoted; nothing else
  // in that file names the engine.
  const lines = readFileSync("pnpm-workspace.yaml", "utf8").split("\n");
  refuseFolders(
    "pnpm-workspace.yaml",
    lines.map((l) => l.match(/^\s*["']?(@werunfoundry\/[^"':\s]+)["']?\s*:\s*["']?([^"'\s#]+)["']?/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
}

if (failures.length === 0) {
  console.log(`instance: ok (${tracked.length} files)`);
  process.exit(0);
}

console.error(`\ninstance: ${failures.length} problem(s)\n`);
for (const f of failures) {
  console.error(`  ${f.line ? `${f.file}:${f.line}` : f.file}\n      ${f.msg}`);
}
console.error("\nDOCTRINE.md in the engine explains what belongs where.\n");
process.exit(1);
