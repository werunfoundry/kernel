#!/usr/bin/env node
/**
 * Copies `template/` into a new directory and makes it standalone.
 *
 * The template is a workspace package here, so that it is typechecked in CI
 * against the real contracts rather than being a folder of hopeful examples.
 * That means its dependencies read `workspace:*`, which means exactly nothing
 * outside this repository — so the copy rewrites them to the version this
 * commit publishes: `0.1.0-main.g` and seven characters of HEAD (decision
 * 0073). A caret on `0.1.0` matches no prerelease; the instance pins exactly.
 *
 *   node scripts/new-instance.mjs ../my-instance
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { versionOf } from "./publish.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

if (!target) {
  console.error("usage: node scripts/new-instance.mjs <directory>");
  process.exit(2);
}

const to = resolve(target);
if (existsSync(to)) {
  console.error(`${target} already exists — pick a directory that does not.`);
  process.exit(1);
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = versionOf(sha);

// Everything except the workspace links, which mean nothing outside it.
cpSync(join(root, "template"), to, {
  recursive: true,
  filter: (src) => !/(^|\/)node_modules(\/|$)/.test(src),
});

// The example truth is dated the day the instance is made. A fixed date in the
// template made every new instance report it stale at birth — a warning that
// says nothing and teaches people to skip warnings. From today it ages like
// any truth: stale in three months if nobody has replaced it, which is when
// the warning has something to say.
const icpPath = join(to, "truths/example-icp.yaml");
const icp = readFileSync(icpPath, "utf8");
const dated = icp.replace(/^validatedAt: "[^"]*"$/m, `validatedAt: "${new Date().toISOString().slice(0, 10)}"`);
if (dated === icp) {
  console.error("new-instance: truths/example-icp.yaml has no validatedAt line to date — the template changed and this script did not.");
  process.exit(1);
}
writeFileSync(icpPath, dated);

const pkgPath = join(to, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (spec === "workspace:*") pkg.dependencies[name] = version;
}
pkg.name = target.split("/").filter(Boolean).pop();
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// Outside the workspace there is no ../tsconfig.base.json to extend.
//
// Two options here look like mistakes next to the kernel's own config, and are
// not (decision 0008). The kernel emits JavaScript, so it writes `./x.js` and
// cannot allow `.ts` imports. An instance never emits: Node runs its
// TypeScript directly, by stripping the types, and Node only finds a file by
// the name it has — so an instance writes `./x.ts`, and needs
// `allowImportingTsExtensions` to say so. `erasableSyntaxOnly` refuses, at
// typecheck, the syntax stripping cannot remove — enums, namespaces,
// constructor parameter properties — which would otherwise fail at run time.
const tsconfig = join(to, "tsconfig.json");
writeFileSync(
  tsconfig,
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023"],
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        types: ["node"],
      },
      include: ["**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  )}\n`,
);

console.log(`
instance created at ${target}, pinned to engine ${version}

  cd ${target}
  git init && pnpm install
  cp .env.example .env
  pnpm exec kernel-fingerprint --label V1 --writes --reason "the instance's first version"

Put the secret it prints in .env and its block at the end of manifest.yaml:
the instance boots only once it declares the version an erasure writes
under (decision 0058). Then fill manifest.yaml and delete the example
binding and adapter.
`);
