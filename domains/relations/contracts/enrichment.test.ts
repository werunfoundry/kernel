/**
 * Tests for what a caller does with an enrichment's answer. The contract's
 * other promise — failure is an error, never an empty result — is a property
 * of adapters, and is tested on the template's example adapter.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CallContext, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";

import type { Completion, Enrichment, EnrichmentSource } from "./enrichment.js";
import { acceptCompletion, completeInSequence } from "./enrichment.js";

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

/* -------------------------------------------------------------------------- */
/* A sequence of sources (decision 0030)                                       */
/* -------------------------------------------------------------------------- */

describe("completing through a sequence of sources", () => {
  const ctx: CallContext = { runId: "r-1", actor: { type: "system" }, dryRun: true };
  const id = { kind: "social_profile_id", network: "net_a", value: "p-1" };
  const email = { kind: "email", value: "ada@example.com" };
  const handle = { kind: "social_profile_handle", network: "net_a", value: "ada" };

  /** A source that answers `answer` and records what it was asked for. */
  function source(provider: string, finds: string[], answer: CallResult<Completion>) {
    const asked: string[][] = [];
    const adapter: Enrichment = {
      provider,
      finds,
      async complete({ want }) {
        asked.push([...(want ?? [])]);
        return answer;
      },
    };
    return { asked, entry: { adapter, provider, finds } satisfies EnrichmentSource };
  }
  const found = (...keys: object[]): CallResult<Completion> => ({ ok: true, value: { found: true, asOf, attested: { subject: "person", keys: keys as Identity["keys"] } } });
  const absent: CallResult<Completion> = { ok: true, value: { found: false, asOf } };

  it("stops asking once every wanted kind is found: the second source is not called", async () => {
    const a = source("a", ["email"], found(id, email));
    const b = source("b", ["email"], found(id, email));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.identity.keys, [id, email]);
    assert.deepEqual(b.asked, []);
    assert.deepEqual(r.steps, [{ provider: "a", asked: ["email"], outcome: "added", added: ["email"] }]);
  });

  it("asks the next source when the previous one did not find the subject", async () => {
    const a = source("a", ["email"], absent);
    const b = source("b", ["email"], found(id, email));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.identity.keys, [id, email]);
    assert.deepEqual(r.steps.map((s) => `${s.provider}:${s.outcome}`), ["a:not found", "b:added"]);
  });

  it("asks the next source when the previous one found the subject without the wanted kind", async () => {
    const a = source("a", ["email", "social_profile_handle"], found(id, handle));
    const b = source("b", ["email"], found(id, email));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(b.asked, [["email"]]);
    assert.deepEqual(r.identity.keys, [id, handle, email]);
  });

  it("asks the next source when the contract rejects the previous answer, and records why", async () => {
    const a = source("a", ["email"], found(email));
    const b = source("b", ["email"], found(id, { kind: "email", value: "ada@example.org" }));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.identity.keys, [id, { kind: "email", value: "ada@example.org" }]);
    assert.deepEqual(r.steps[0], { provider: "a", asked: ["email"], outcome: "rejected", rejected: UNTIED.rejected });
  });

  it("stops on an error: the source after it is not asked, and the failure names its source", async () => {
    const a = source("a", ["email"], { ok: false, error: { code: "unavailable", message: "down", retryable: true } });
    const b = source("b", ["email"], found(id, email));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.provider, "a");
    assert.equal(r.error.code, "unavailable");
    assert.deepEqual(b.asked, []);
  });

  it("asks a source only for kinds it declares and that are still missing", async () => {
    const a = source("a", ["email"], found(id, email));
    const b = source("b", ["email", "social_profile_handle"], found(id, handle));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email", "social_profile_handle"] }, vocabulary, ctx);
    assert.ok(r.ok);
    assert.deepEqual(a.asked, [["email"]]);
    assert.deepEqual(b.asked, [["social_profile_handle"]]);
  });

  it("does not call a source that finds none of the missing kinds", async () => {
    const a = source("a", ["social_profile_handle"], found(id, handle));
    const r = await completeInSequence([a.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(a.asked, []);
    assert.deepEqual(r.missing, ["email"]);
    assert.deepEqual(r.steps, []);
  });

  it("records a dry run's simulated answer as nothing learnt: the kind stays missing, and the next source is asked", async () => {
    const a = source("a", ["email"], { ok: true, simulated: true, value: { found: false, asOf } });
    const b = source("b", ["email"], found(id, email));
    const r = await completeInSequence([a.entry, b.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.steps.map((s) => `${s.provider}:${s.outcome}`), ["a:simulated", "b:added"]);
  });

  it("carries what the provider said about the keys it added, and only those, with what it cost", async () => {
    const other = { kind: "email", value: "other@example.com" };
    const a = source("a", ["email"], {
      ok: true,
      value: {
        found: true,
        asOf,
        attested: { subject: "person", keys: [id, { kind: "email", value: "Ada@Example.com" }] },
        said: [
          { key: { kind: "email", value: "Ada@Example.com" }, status: "CATCH_ALL" },
          { key: other, status: "DELIVERABLE" },
        ],
        cost: { amount: 1, unit: "credits" },
      },
    });
    const r = await completeInSequence([a.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.steps[0]?.said, [{ key: email, status: "CATCH_ALL" }]);
    assert.deepEqual(r.steps[0]?.cost, { amount: 1, unit: "credits" });
  });

  it("keeps the cost of an answer that found nothing", async () => {
    const a = source("a", ["email"], { ok: true, value: { found: false, asOf, cost: { amount: 0, unit: "credits" } } });
    const r = await completeInSequence([a.entry], { identity: asked, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.steps[0]?.cost, { amount: 0, unit: "credits" });
  });

  it("asks nobody for a kind the subject already has", async () => {
    const a = source("a", ["email"], found(id, email));
    const r = await completeInSequence([a.entry], { identity: { subject: "person", keys: [id, email] }, want: ["email"] }, vocabulary, ctx);
    assert.ok(r.ok);
    assert.deepEqual(a.asked, []);
  });
});
