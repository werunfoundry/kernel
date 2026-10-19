/**
 * Tests for the check an instance runs on itself — the rule of decision 0025
 * only: the engine is consumed as a published version or a packed tarball,
 * never a folder. Each test writes one instance with one dependency spec and
 * asserts what the check says about it.
 *
 *   node --test "scripts/**\/*.test.mjs"
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "../core/scripts/check-instance.mjs");
const made = [];

function instance(files) {
  const dir = mkdtempSync(join(tmpdir(), "instance-"));
  made.push(dir);
  for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const pkg = (fields) => JSON.stringify({ name: "x", private: true, ...fields }, null, 2);

function run(dir) {
  const r = spawnSync(process.execPath, [CHECK], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const refuses = (dir, needle) => {
  const { code, out } = run(dir);
  assert.equal(code, 1, `expected a refusal:\n${out}`);
  assert.match(out, /decision 0025/, out);
  assert.match(out, new RegExp(needle), out);
};
const accepts = (dir) => {
  const { code, out } = run(dir);
  assert.equal(code, 0, `expected acceptance:\n${out}`);
};

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("decision 0025 — the engine is consumed as published, never as a folder", () => {
  it("accepts a version and a packed tarball", () => {
    accepts(instance({ "package.json": pkg({ dependencies: { "@werunfoundry/core": "^0.1.0", "@werunfoundry/acquisition": "file:../packs/werunfoundry-acquisition-0.1.0.tgz" } }) }));
  });

  it("refuses a folder by file:", () => {
    refuses(instance({ "package.json": pkg({ dependencies: { "@werunfoundry/core": "file:../kernel/core" } }) }), "file:\\.\\./kernel/core");
  });

  it("refuses link:, portal: and workspace:", () => {
    for (const spec of ["link:../kernel/core", "portal:../kernel/core", "workspace:*"]) {
      refuses(instance({ "package.json": pkg({ devDependencies: { "@werunfoundry/core": spec } }) }), spec.replace("*", "\\*"));
    }
  });

  it("refuses a folder in the overrides, where it replaces a version without saying so", () => {
    refuses(instance({ "package.json": pkg({ pnpm: { overrides: { "@werunfoundry/acquisition": "file:../kernel/domains/acquisition" } } }) }), "acquisition");
    refuses(instance({ "package.json": pkg({}), "pnpm-workspace.yaml": 'overrides:\n  "@werunfoundry/relations": "file:../kernel/domains/relations"\n' }), "relations");
  });

  it("leaves other packages' specs alone: the rule is about the engine", () => {
    accepts(instance({ "package.json": pkg({ dependencies: { "some-local-tool": "file:../tool" } }) }));
  });
});
