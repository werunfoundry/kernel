#!/usr/bin/env node
/**
 * kernel-fingerprint — a person adds a version of the secret the register's
 * fingerprints are keyed under (decision 0058), run from an instance's root.
 *
 *   kernel-fingerprint --label <LABEL> --reason "<why it is added>" [--writes]
 *
 * It generates the secret — 32 random bytes from the operating system's
 * generator, never chosen — and prints two things for the person to keep:
 * the variable's line for the instance's environment, and the version's
 * label, check value and reason for `fingerprints.versions` in the
 * manifest. With `--writes`, the version is the one new entries are written
 * under, and `fingerprints.writes` names it.
 *
 * It writes nothing and connects to nothing. The secret is printed once and
 * kept by whoever runs it: it is never stored by the kernel, and an instance
 * keeps every version it has used for as long as an entry names it (0052).
 * A version is added for a reason, which the manifest records; the kernel
 * adds none by itself.
 */

import { checkValueOf, generateSecret, LABEL, variableOf } from "../runtime/fingerprint.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []))[0];

function main(): number {
  const label = value("label")?.trim() ?? "";
  const reason = value("reason")?.trim() ?? "";
  if (!LABEL.test(label)) {
    console.log("fingerprint: --label is upper-case letters and digits, and is never renamed or reused (decision 0058).");
    return 1;
  }
  if (!reason) {
    console.log("fingerprint: --reason is required: a version is added for a reason, which the manifest keeps (decision 0058).");
    return 1;
  }
  const secret = generateSecret();
  const writes = flag("writes");
  console.log(`# For the instance's environment, never committed. Kept for as long as an entry names ${label} (decision 0052).`);
  console.log(`${variableOf(label)}=${secret}`);
  console.log("");
  const version = [`    - label: ${label}`, `      check: ${checkValueOf(secret)}`, `      reason: ${JSON.stringify(reason)}`];
  if (writes) {
    console.log(`# For manifest.yaml: this version under \`fingerprints.versions\`, and \`fingerprints.writes: ${label}\`.`);
    console.log("# A manifest with no `fingerprints` section yet takes the whole block.");
    for (const line of ["fingerprints:", `  writes: ${label}`, "  versions:", ...version]) console.log(line);
  } else {
    console.log("# For manifest.yaml: this version under `fingerprints.versions`. It does not write.");
    for (const line of version) console.log(line);
  }
  return 0;
}

process.exitCode = main();
