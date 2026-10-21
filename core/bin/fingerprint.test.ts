/**
 * Tests for `kernel-fingerprint` (decision 0058), run as a person runs it:
 * the command as a process, from an empty directory, so that what it writes
 * — nothing — can be seen.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { checkValueOf } from "../runtime/fingerprint.js";

const cwd = mkdtempSync(join(tmpdir(), "kernel-fingerprint-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: string[]): Promise<{ status: number | null; out: string }> {
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "fingerprint.ts"), ...args], { cwd });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, out })));
}

describe("kernel-fingerprint", () => {
  it("prints a generated secret for the environment, and the version for the manifest with its check value, writing nothing", async () => {
    const r = await run(["--label", "V2", "--writes", "--reason", "V1 was in a leaked backup"]);
    assert.equal(r.status, 0, r.out);
    const secret = r.out.match(/^KERNEL_FINGERPRINT_V2=([0-9a-f]{64})$/m)?.[1];
    assert.ok(secret, r.out);
    assert.match(r.out, new RegExp(`^fingerprints:\\n  writes: V2\\n  versions:\\n    - label: V2\\n      check: ${checkValueOf(secret)}\\n      reason: "V1 was in a leaked backup"$`, "m"));
    assert.deepEqual(readdirSync(cwd), []);
  });

  it("generates another secret on every run", async () => {
    const secrets = await Promise.all([1, 2].map(async () => (await run(["--label", "V3", "--reason", "x"])).out.match(/=([0-9a-f]{64})$/m)?.[1]));
    assert.ok(secrets[0] && secrets[1] && secrets[0] !== secrets[1]);
  });

  it("prints only the version, without --writes", async () => {
    const r = await run(["--label", "V3", "--reason", "every quarter, as counsel asked"]);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /writes:/);
    assert.match(r.out, /It does not write\.\n    - label: V3\n/);
  });

  it("refuses a label that is not upper-case letters and digits, and a version without its reason", async () => {
    for (const args of [["--label", "v1", "--reason", "x"], ["--label", "V-1", "--reason", "x"], ["--reason", "x"]]) {
      const r = await run(args);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /--label is upper-case letters and digits/);
    }
    const r = await run(["--label", "V1", "--reason", " "]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--reason is required/);
    assert.doesNotMatch(r.out, /KERNEL_FINGERPRINT/);
  });
});
