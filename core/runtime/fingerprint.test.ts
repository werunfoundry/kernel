/**
 * Tests for the fingerprint (decisions 0058, 0062).
 *
 * The encoding is pinned by computing it again here, from node:crypto and
 * the decision's words, rather than through the module: a change to it would
 * make every entry already written match nothing, and must fail a test
 * before it can do that.
 */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import type { DomainManifest } from "../manifest/types.js";
import { identityVocabulary } from "../identity/index.js";
import { checkValueOf, fingerprinter, fingerprintOf, generateSecret, HEX64, variableOf, wrap } from "./fingerprint.js";

const domain = {
  name: "people",
  version: "0.0.0",
  description: "x",
  schema: "people",
  dependsOn: [],
  identityKeys: [
    { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
    { kind: "social_profile_id", subject: "person", immutable: true, networked: true },
    { kind: "domain", subject: "company", immutable: false, caseInsensitive: true, hostname: true },
  ],
} as DomainManifest;
const vocabulary = identityVocabulary([domain], ["network_a"]);

/** The decision's words: kind, network (empty when none) and value joined by NUL, as UTF-8, under HMAC-SHA-256 of the secret's 32 bytes. */
const byHand = (secret: string, kind: string, network: string, value: string) =>
  createHmac("sha256", Buffer.from(secret, "hex")).update(Buffer.from(`${kind}\u0000${network}\u0000${value}`, "utf8")).digest("hex");

describe("a fingerprint (0062)", () => {
  const secret = generateSecret();

  it("is the HMAC-SHA-256 of the normalised key's kind, network and value joined by NUL, as 64 lower-case hex", () => {
    assert.equal(fingerprintOf(secret, { kind: "email", value: " Ada@Example.COM " }, vocabulary), byHand(secret, "email", "", "ada@example.com"));
    assert.equal(fingerprintOf(secret, { kind: "social_profile_id", network: "network_a", value: "ada-1" }, vocabulary), byHand(secret, "social_profile_id", "network_a", "ada-1"));
    assert.equal(fingerprintOf(secret, { kind: "domain", value: "https://WWW.Example.org/about" }, vocabulary), byHand(secret, "domain", "", "example.org"));
    assert.match(fingerprintOf(secret, { kind: "email", value: "a@example.com" }, vocabulary), HEX64);
  });

  it("differs under another secret, and between keys that differ only by their network", () => {
    const other = generateSecret();
    const key = { kind: "social_profile_id", network: "network_a", value: "ada-1" };
    assert.notEqual(fingerprintOf(secret, key, vocabulary), fingerprintOf(other, key, vocabulary));
    assert.notEqual(fingerprintOf(secret, key, vocabulary), fingerprintOf(secret, { ...key, network: "network_b" }, vocabulary));
  });

  it("wraps an entry under the next version: HMAC of the previous fingerprint's 32 bytes (0058, §3)", () => {
    const next = generateSecret();
    const first = fingerprintOf(secret, { kind: "email", value: "ada@example.com" }, vocabulary);
    assert.equal(wrap(next, first), createHmac("sha256", Buffer.from(next, "hex")).update(Buffer.from(first, "hex")).digest("hex"));
    assert.notEqual(wrap(next, first), fingerprintOf(next, { kind: "email", value: "ada@example.com" }, vocabulary));
  });

  it("has a check value that is no key's fingerprint, and that another secret does not reproduce (0058, §1)", () => {
    assert.match(checkValueOf(secret), HEX64);
    assert.equal(checkValueOf(secret), checkValueOf(secret));
    assert.notEqual(checkValueOf(secret), checkValueOf(generateSecret()));
    assert.equal(createHmac("sha256", Buffer.from(secret, "hex")).update("the check value of a fingerprint version (decision 0058)").digest("hex"), checkValueOf(secret));
  });

  it("generates 32 random bytes as 64 lower-case hex, and reads a version's secret from a name derived from its label", () => {
    const a = generateSecret();
    assert.match(a, HEX64);
    assert.notEqual(a, generateSecret());
    assert.equal(variableOf("V2"), "KERNEL_FINGERPRINT_V2");
  });
});

describe("what an erasure is handed (0062)", () => {
  it("fingerprints under the version that writes, says what is missing, and holds no secret it would show", () => {
    const secret = generateSecret();
    const f = fingerprinter("V2", secret, ["V1"], vocabulary);
    const key = { kind: "email", value: "ada@example.com" };
    assert.deepEqual(f.fingerprint(key), { fingerprint: byHand(secret, "email", "", "ada@example.com"), chain: ["V2"] });
    assert.deepEqual([f.writes, [...f.missing]], ["V2", ["V1"]]);
    assert.doesNotMatch(JSON.stringify(f), new RegExp(secret));
    assert.ok(Object.isFrozen(f));
  });
});
