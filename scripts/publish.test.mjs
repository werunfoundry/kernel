/**
 * The version a commit publishes under (decision 0073).
 *
 * The `g` is not decoration: a prerelease identifier of digits alone with a
 * leading zero is not a version. Without the letter, a sha like `0123456`
 * fails the publish and the error does not say why. This loads the semver
 * npm ships, so removing the `g` fails here before it fails on the registry.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { versionOf } from "./publish.mjs";

const require = createRequire(import.meta.url);
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const semver = require(join(npmRoot, "npm/node_modules/semver"));

describe("versionOf — 0.1.0-main.g and seven characters of the commit", () => {
  it("cuts seven characters and prefixes g", () => {
    assert.equal(versionOf("abcdef0123456789"), "0.1.0-main.gabcdef0");
    assert.equal(versionOf("ABCDEF0"), "0.1.0-main.gabcdef0");
  });

  it("refuses a short or empty sha", () => {
    assert.throws(() => versionOf("abc"), /git sha/);
    assert.throws(() => versionOf(""), /git sha/);
  });
});

describe("the g keeps a numeric leading-zero sha a legal version", () => {
  it("rejects 0.1.0-main.0123456 and accepts 0.1.0-main.g0123456", () => {
    assert.equal(semver.valid("0.1.0-main.0123456"), null);
    assert.equal(semver.valid("0.1.0-main.g0123456"), "0.1.0-main.g0123456");
  });

  it("versionOf(0123456…) is what semver accepts", () => {
    const v = versionOf("0123456789abcdef");
    assert.equal(v, "0.1.0-main.g0123456");
    assert.equal(semver.valid(v), v);
  });
});
