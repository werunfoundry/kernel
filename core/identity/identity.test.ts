/**
 * Tests for the identity mechanism. Pure functions over a vocabulary built the
 * way boot builds it; the vocabulary's real source — a domain's domain.yaml,
 * found where an instance installed it — is crossed in boot.test.ts.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { DomainManifest } from "../manifest/types.js";
import { checkIdentity, compareIdentities, hostOf, identityVocabulary, keysOfKind, normalizeIdentity } from "./index.js";
import type { Identity } from "./index.js";

const domain: DomainManifest = {
  name: "people",
  version: "0.0.0",
  description: "x",
  schema: "people",
  dependsOn: [],
  identityKeys: [
    { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
    { kind: "profile_id", subject: "person", immutable: true, networked: true },
    { kind: "domain", subject: "company", immutable: false, caseInsensitive: true, hostname: true },
    { kind: "code", subject: "company", immutable: false, caseInsensitive: true },
  ],
};
const vocabulary = identityVocabulary([domain], ["net_a", "net_b"]);

const person = (...keys: Identity["keys"]): Identity => ({ subject: "person", keys });

describe("comparing identities", () => {
  it("is the same subject on a shared immutable key", () => {
    assert.equal(
      compareIdentities(
        person({ kind: "profile_id", network: "net_a", value: "p1" }),
        person({ kind: "profile_id", network: "net_a", value: "p1" }, { kind: "email", value: "ada@example.com" }),
        vocabulary,
      ),
      "same_immutable",
    );
  });

  it("is a conflict when immutable keys disagree, even if the address matches", () => {
    assert.equal(
      compareIdentities(
        person({ kind: "profile_id", network: "net_a", value: "p1" }, { kind: "email", value: "ada@example.com" }),
        person({ kind: "profile_id", network: "net_a", value: "p2" }, { kind: "email", value: "ADA@example.com" }),
        vocabulary,
      ),
      "conflict",
    );
  });

  it("treats the same id on two networks as two keys, not one", () => {
    assert.equal(
      compareIdentities(
        person({ kind: "profile_id", network: "net_a", value: "p1" }),
        person({ kind: "profile_id", network: "net_b", value: "p1" }),
        vocabulary,
      ),
      "unknown",
    );
  });

  it("calls a shared address evidence, not proof", () => {
    assert.equal(
      compareIdentities(person({ kind: "email", value: " Ada@Example.com " }), person({ kind: "email", value: "ada@example.com" }), vocabulary),
      "same_mutable",
    );
  });

  it("never matches a person with a company", () => {
    assert.equal(
      compareIdentities(person({ kind: "email", value: "ada@example.com" }), { subject: "company", keys: [{ kind: "domain", value: "example.com" }] }, vocabulary),
      "unknown",
    );
  });

  it("works with a single key, which is what an identity usually starts as", () => {
    assert.equal(compareIdentities(person({ kind: "email", value: "a@example.com" }), person({ kind: "email", value: "b@example.com" }), vocabulary), "unknown");
  });
});

describe("checking an identity", () => {
  it("accepts a well-formed one", () => {
    assert.deepEqual(checkIdentity(person({ kind: "email", value: "ada@example.com" }, { kind: "profile_id", network: "net_a", value: "p1" }), vocabulary), []);
  });

  it("refuses an undeclared network, so two spellings of one cannot coexist", () => {
    const issues = checkIdentity(person({ kind: "profile_id", network: "Net_A", value: "p1" }), vocabulary);
    assert.match(issues.map((i) => i.message).join("\n"), /declares no network "Net_A"/);
  });

  it("refuses a networked key with no network, and a network on a key that has none", () => {
    const said = checkIdentity(
      person({ kind: "profile_id", value: "p1" }, { kind: "email", network: "net_a", value: "ada@example.com" }),
      vocabulary,
    ).map((i) => i.message).join("\n");
    assert.match(said, /needs a network/);
    assert.match(said, /is not tied to a network/);
  });

  it("refuses an undeclared kind, a key for the wrong subject, and an empty identity", () => {
    const said = [
      ...checkIdentity(person({ kind: "phone", value: "1" }), vocabulary),
      ...checkIdentity(person({ kind: "domain", value: "example.com" }), vocabulary),
      ...checkIdentity({ subject: "person", keys: [] }, vocabulary),
    ].map((i) => i.message).join("\n");
    assert.match(said, /no enabled domain declares the identity key "phone"/);
    assert.match(said, /names a company, not a person/);
    assert.match(said, /names nothing/);
  });
});

describe("normalizing", () => {
  it("lower-cases what the kind says is case-blind, and drops duplicates", () => {
    const n = normalizeIdentity(person({ kind: "email", value: " Ada@Example.com" }, { kind: "email", value: "ada@example.com" }), vocabulary);
    assert.deepEqual(n.keys, [{ kind: "email", value: "ada@example.com" }]);
    assert.deepEqual(keysOfKind(n, "email"), ["ada@example.com"]);
  });

  it("keeps case where it may carry meaning", () => {
    const n = normalizeIdentity(person({ kind: "profile_id", network: "net_a", value: "AbC" }), vocabulary);
    assert.equal(n.keys[0]?.value, "AbC");
  });
});

describe("a key that names a host (decision 0028)", () => {
  it("is the host, whatever a source wrapped around it", () => {
    // Spellings seen in a real target list, and the ones a URL can take.
    for (const [raw, host] of [
      ["Meetz.ai", "meetz.ai"],
      ["http://Jobot.com", "jobot.com"],
      ["https://www.Example.com/about?ref=x#top", "example.com"],
      ["  WWW.example.org.  ", "example.org"],
      ["example.com:443", "example.com"],
      ["@example.com", "example.com"],
      ["mailto://ops@example.com", "example.com"],
      ["app.example.com", "app.example.com"],
      ["http://", ""],
      ["", ""],
    ]) assert.equal(hostOf(raw!), host, raw);
  });

  it("is applied by normalising, only to the kinds that name a host", () => {
    const company = (...keys: Identity["keys"]): Identity => ({ subject: "company", keys });
    const n = normalizeIdentity(company({ kind: "domain", value: "https://WWW.Example.com/" }, { kind: "domain", value: "example.com" }), vocabulary);
    assert.deepEqual(n.keys, [{ kind: "domain", value: "example.com" }], "two spellings of one host are one key");
    const other = normalizeIdentity(company({ kind: "code", value: "HTTP://X/Y" }), vocabulary);
    assert.equal(other.keys[0]?.value, "http://x/y", "a case-blind kind that is not a host keeps its slashes");
  });
});
