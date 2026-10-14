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
      ],
    },
  ],
  ["net_a"],
);

const asked: Identity = { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-1" }] };
const asOf = "2026-01-01T00:00:00Z";

describe("accepting a completion", () => {
  it("takes the keys the provider added, and keeps the ones it was given", () => {
    const r = acceptCompletion(
      asked,
      {
        found: true,
        asOf,
        identity: { subject: "person", keys: [...asked.keys, { kind: "email", value: "Ada@Example.com" }] },
        added: [{ kind: "email", value: "Ada@Example.com" }],
      },
      vocabulary,
    );
    assert.ok("accepted" in r, JSON.stringify(r));
    if ("accepted" in r) assert.deepEqual(r.added, [{ kind: "email", value: "ada@example.com" }]);
  });

  it("rejects an answer about someone else — an immutable key that differs", () => {
    const r = acceptCompletion(
      asked,
      {
        found: true,
        asOf,
        identity: { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-2" }, { kind: "email", value: "x@example.com" }] },
        added: [],
      },
      vocabulary,
    );
    assert.deepEqual(r, { rejected: "an immutable key differs: this is someone else" });
  });

  it("rejects an answer that dropped a key it was asked about", () => {
    const r = acceptCompletion(asked, { found: true, asOf, identity: { subject: "person", keys: [{ kind: "email", value: "x@example.com" }] }, added: [] }, vocabulary);
    assert.ok("rejected" in r);
  });

  it("rejects an answer about another kind of subject", () => {
    const r = acceptCompletion(asked, { found: true, asOf, identity: { subject: "company", keys: asked.keys }, added: [] }, vocabulary);
    assert.ok("rejected" in r);
  });

  it("reports not found as not found", () => {
    assert.deepEqual(acceptCompletion(asked, { found: false, asOf }, vocabulary), { rejected: "not found" });
  });
});
