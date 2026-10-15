/**
 * Tests for what a caller does with an enrichment's answer. The contract's
 * other promise — failure is an error, never an empty result — is a property
 * of adapters, and is tested on the template's example adapter.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";

import { acceptCompletion } from "./enrichment.js";

const vocabulary = identityVocabulary(
  [
    {
      name: "relations",
      version: "0.0.0",
      description: "x",
      schema: "relations",
      dependsOn: [],
      identityKeys: [
        { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
        { kind: "social_profile_id", subject: "person", immutable: true, networked: true },
        { kind: "social_profile_handle", subject: "person", immutable: false, networked: true },
      ],
    },
  ],
  ["net_a"],
);

const asked: Identity = { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-1" }] };
const asOf = "2026-01-01T00:00:00Z";

const UNTIED = { rejected: "the answer attests no immutable key of the subject asked about: nothing ties it to them" };

describe("accepting a completion", () => {
  it("takes the keys the provider added, and keeps the ones it was given", () => {
    const r = acceptCompletion(
      asked,
      { found: true, asOf, attested: { subject: "person", keys: [...asked.keys, { kind: "email", value: "Ada@Example.com" }] } },
      vocabulary,
    );
    assert.ok("accepted" in r, JSON.stringify(r));
    if ("accepted" in r) {
      assert.deepEqual(r.added, [{ kind: "email", value: "ada@example.com" }]);
      assert.deepEqual(r.accepted.keys, [...asked.keys, { kind: "email", value: "ada@example.com" }]);
    }
  });

  it("does not need the answer to repeat a mutable key it was asked by", () => {
    const withHandle: Identity = { subject: "person", keys: [...asked.keys, { kind: "social_profile_handle", network: "net_a", value: "ada" }] };
    const r = acceptCompletion(withHandle, { found: true, asOf, attested: { subject: "person", keys: [...asked.keys, { kind: "email", value: "ada@example.com" }] } }, vocabulary);
    assert.ok("accepted" in r, JSON.stringify(r));
    if ("accepted" in r) assert.deepEqual(r.accepted.keys, [...withHandle.keys, { kind: "email", value: "ada@example.com" }]);
  });

  it("rejects an answer about someone else — an immutable key that differs", () => {
    const r = acceptCompletion(
      asked,
      { found: true, asOf, attested: { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-2" }, { kind: "email", value: "x@example.com" }] } },
      vocabulary,
    );
    assert.deepEqual(r, { rejected: "an immutable key differs: this is someone else" });
  });

  // The fixtures below hold no immutable key that differs, so only the
  // requirement that the answer attest one can refuse them.
  it("rejects an answer that attests no immutable key: the provider's word alone", () => {
    const r = acceptCompletion(asked, { found: true, asOf, attested: { subject: "person", keys: [{ kind: "email", value: "x@example.com" }] } }, vocabulary);
    assert.deepEqual(r, UNTIED);
  });

  it("rejects an answer tied to the request by a mutable key only", () => {
    const byAddress: Identity = { subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] };
    const r = acceptCompletion(
      byAddress,
      { found: true, asOf, attested: { subject: "person", keys: [{ kind: "email", value: "ada@example.com" }, { kind: "social_profile_id", network: "net_a", value: "p-9" }] } },
      vocabulary,
    );
    assert.deepEqual(r, UNTIED);
  });

  it("rejects an answer about another kind of subject", () => {
    const r = acceptCompletion(asked, { found: true, asOf, attested: { subject: "company", keys: asked.keys } }, vocabulary);
    assert.deepEqual(r, { rejected: "asked about a person, answered about a company" });
  });

  it("reports not found as not found", () => {
    assert.deepEqual(acceptCompletion(asked, { found: false, asOf }, vocabulary), { rejected: "not found" });
  });
});
