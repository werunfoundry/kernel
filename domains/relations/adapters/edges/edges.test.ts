/**
 * Every `assert.ok` here carries a message. Without one, a failing
 * `assert.ok` under tsx can hang while Node rebuilds the message from the
 * source, and the failure surfaces as a timeout instead of a failure.
 *
 * Tests for the enrichment adapter, against a fake of the provider's API in
 * the shapes its documentation gives. No real workspace is read: what is
 * proven is the contract's shape and its fail-closed behaviour (CLAUDE.md §5:
 * this is the seam; reading a real workspace is integration, done with the
 * owner).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";

import { acceptCompletion } from "../../contracts/enrichment.js";
import factory from "./index.js";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  key?: string;
}

const state = {
  employees: [] as Record<string, unknown>[],
  next: null as string | null,
  contact: {} as Record<string, unknown>,
  forceStatus: 0,
  hang: false,
};
let seen: Seen[] = [];
const everyRequest: Seen[] = [];
const hung: ServerResponse[] = [];
let server: Server;
let baseUrl = "";
type Server = import("node:http").Server;

const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b));
  });

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fake");
  const text = await read(req);
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  const entry: Seen = { method: req.method ?? "", path: url.pathname + url.search, ...(body ? { body } : {}), ...(req.headers["x-api-key"] ? { key: String(req.headers["x-api-key"]) } : {}) };
  seen.push(entry);
  everyRequest.push({ method: entry.method, path: url.pathname });
  const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(value));
  };
  if (state.hang) {
    hung.push(res);
    return;
  }
  if (state.forceStatus === 429) return reply(429, { message: "slow down" }, { "retry-after": "12" });
  if (state.forceStatus) return reply(state.forceStatus, { message: `forced ${state.forceStatus}` });
  if (req.method === "GET" && url.pathname === "/workspaces") return reply(200, { name: "fixture", uid: "w" });
  if (req.method === "POST" && url.pathname === "/actions/linkedin-search-company-employees/run/live") {
    return reply(200, { items: state.employees }, state.next ? { "x-pagination-next": state.next } : {});
  }
  if (req.method === "POST" && url.pathname === "/actions/linkedin-extract-contact/run/live") return reply(200, state.contact);
  return reply(404, { message: `fake has no ${req.method} ${url.pathname}` });
}

before(async () => {
  server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: `fake failed: ${(error as Error).message}` }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  for (const res of hung.splice(0)) res.destroy();
  state.employees = [];
  state.next = null;
  state.contact = {};
  state.forceStatus = 0;
  state.hang = false;
  seen = [];
});

const ctx = (dryRun = true): CallContext => ({ runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" }, dryRun });
const adapter = (options: Record<string, string | number | boolean> = {}, key: string | null = "test-key") =>
  factory({ options: { baseUrl, network: "net_a", ...options }, env: key === null ? {} : { EDGES_API_KEY: key } });
const company = (...keys: Identity["keys"]): Identity => ({ subject: "company", keys });
const attested = company({ kind: "social_company_id", network: "net_a", value: "4242" });

describe("probe", () => {
  it("reads the workspace with the key in X-API-Key", async () => {
    assert.equal((await adapter().probe!(ctx())).ok, true);
    assert.deepEqual([seen[0]?.method, seen[0]?.path, seen[0]?.key], ["GET", "/workspaces", "test-key"]);
  });

  it("fails without a key, calling nobody", async () => {
    assert.equal((await adapter({}, null).probe!(ctx())).ok, false);
    assert.equal(seen.length, 0);
  });

  it("gives up on a provider that never answers", async () => {
    state.hang = true;
    const r = await adapter({ timeoutMs: 200 }).probe!(ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /no answer within 200 ms/.test(r.error.message), JSON.stringify(r));
  });
});

describe("peopleAt", () => {
  it("refuses a company known only by its domain, calling nobody — finding one from a domain would be a guess", async () => {
    const r = await adapter().peopleAt({ company: company({ kind: "domain", value: "example.com" }) }, ctx());
    // The reason, not only the code: another refusal (a malformed id) must
    // not be what stops it.
    assert.ok(!r.ok && r.error.code === "invalid" && /would mean guessing the company/.test(r.error.message), JSON.stringify(r));
    assert.equal(seen.length, 0);
  });

  it("ignores a company id on another network", async () => {
    const r = await adapter().peopleAt({ company: company({ kind: "social_company_id", network: "net_b", value: "4242" }) }, ctx());
    assert.ok(!r.ok && r.error.code === "invalid", JSON.stringify(r));
  });

  it("returns the people with the keys the network attests, and the next cursor", async () => {
    state.employees = [
      { linkedin_profile_id: 101, linkedin_profile_handle: "ada-example", full_name: "Ada Example", job_title: "Operations" },
      { linkedin_profile_handle: "no-id", full_name: "No Id" },
    ];
    state.next = `${baseUrl}/actions/linkedin-search-company-employees/run/live?cursor=abc`;
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.value.items, [
      {
        identity: {
          subject: "person",
          keys: [
            { kind: "social_profile_id", network: "net_a", value: "101" },
            { kind: "social_profile_handle", network: "net_a", value: "ada-example" },
          ],
        },
        display: { fullName: "Ada Example", title: "Operations" },
      },
    ]);
    assert.equal(r.value.nextCursor, "abc");
    assert.deepEqual((seen[0]?.body as { input: unknown }).input, {
      linkedin_company_url: "https://www.linkedin.com/company/4242/",
      linkedin_company_id: 4242,
    });
    assert.equal((seen[0]?.body as { identity_mode: string }).identity_mode, "auto");
  });

  it("calls an empty page 'could not tell', never 'nobody' — it may be throttling", async () => {
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && r.error.retryable, JSON.stringify(r));
  });

  it("calls a page of people none of whom it can identify 'could not tell' too", async () => {
    state.employees = [{ full_name: "No Id" }];
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(!r.ok && r.error.code === "unavailable", JSON.stringify(r));
  });

  it("runs as the identities the binding names, when it names them", async () => {
    state.employees = [{ linkedin_profile_id: 1 }];
    await adapter({ identityIds: "11111111-1111-4111-8111-111111111111" }).peopleAt({ company: attested }, ctx());
    assert.deepEqual((seen[0]?.body as { identity_ids: string[] }).identity_ids, ["11111111-1111-4111-8111-111111111111"]);
  });
});

describe("errors", () => {
  it("424: the identity running the action failed — could not look, not an answer", async () => {
    state.forceStatus = 424;
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && !r.error.retryable, JSON.stringify(r));
  });

  it("402: no credits left", async () => {
    state.forceStatus = 402;
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized", JSON.stringify(r));
  });

  it("429: rate limited, with the wait it states", async () => {
    state.forceStatus = 429;
    const r = await adapter().peopleAt({ company: attested }, ctx());
    assert.ok(!r.ok && r.error.code === "rate_limited" && r.error.retryAfterMs === 12_000, JSON.stringify(r));
  });
});

describe("complete", () => {
  const ada: Identity = {
    subject: "person",
    keys: [
      { kind: "social_profile_id", network: "net_a", value: "101" },
      { kind: "social_profile_handle", network: "net_a", value: "ada-example" },
    ],
  };
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

  it("adds the address the network shows, from the profile URL built from the handle", async () => {
    state.contact = { email: "Ada@Example.com", linkedin_profile_id: 101, linkedin_profile_handle: "ada-example" };
    const r = await adapter().complete({ identity: ada }, ctx());
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (!r.ok || !r.value.found) return;
    assert.equal((seen[0]?.body as { input: { linkedin_profile_url: string } }).input.linkedin_profile_url, "https://www.linkedin.com/in/ada-example/");
    const accepted = acceptCompletion(ada, r.value, vocabulary);
    assert.ok("accepted" in accepted, `the provider's own answer about Ada was rejected: ${JSON.stringify(accepted)}`);
    if ("accepted" in accepted) assert.deepEqual(accepted.added, [{ kind: "email", value: "ada@example.com" }]);
  });

  it("says found: false when no address is shown to this account", async () => {
    state.contact = { linkedin_profile_id: 101 };
    const r = await adapter().complete({ identity: ada }, ctx());
    assert.ok(r.ok && !r.value.found, JSON.stringify(r));
  });

  it("returns the provider's own keys, so that an answer about someone else is rejected", async () => {
    state.contact = { email: "someone@example.org", linkedin_profile_id: 999 };
    const r = await adapter().complete({ identity: ada }, ctx());
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (r.ok) assert.deepEqual(acceptCompletion(ada, r.value, vocabulary), { rejected: "an immutable key differs: this is someone else" });
  });

  it("reports only what the answer carries, never a key it was handed", async () => {
    state.contact = { email: "ada@example.com" };
    const r = await adapter().complete({ identity: ada }, ctx());
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (r.ok && r.value.found) assert.deepEqual(r.value.attested, { subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] });
  });

  // A handle released by Ada and taken by someone else: the provider answers
  // that person's address and no profile id. Nothing in the fixture differs
  // from Ada's immutable key, so only the requirement that the answer attest
  // one can refuse it.
  describe("a third party's address, and no profile id", () => {
    const untied = { rejected: "the answer attests no immutable key of the subject asked about: nothing ties it to them" };
    beforeEach(() => {
      state.contact = { email: "someone-else@example.org", linkedin_profile_handle: "ada-example" };
    });

    it("is rejected when the request carried Ada's profile id", async () => {
      const r = await adapter().complete({ identity: ada }, ctx());
      assert.ok(r.ok && r.value.found, JSON.stringify(r));
      if (r.ok) assert.deepEqual(acceptCompletion(ada, r.value, vocabulary), untied);
    });

    it("is rejected when the request carried only her handle", async () => {
      const handleOnly: Identity = { subject: "person", keys: [{ kind: "social_profile_handle", network: "net_a", value: "ada-example" }] };
      const r = await adapter().complete({ identity: handleOnly }, ctx());
      assert.ok(r.ok && r.value.found, JSON.stringify(r));
      if (r.ok) assert.deepEqual(acceptCompletion(handleOnly, r.value, vocabulary), untied);
    });
  });

  it("refuses a person without a handle, and a company, calling nobody", async () => {
    const noHandle = await adapter().complete({ identity: { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "101" }] } }, ctx());
    const aCompany = await adapter().complete({ identity: attested }, ctx());
    assert.ok(!noHandle.ok && noHandle.error.code === "invalid", JSON.stringify(noHandle));
    assert.ok(!aCompany.ok && aCompany.error.code === "invalid", JSON.stringify(aCompany));
    assert.equal(seen.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The endpoint surface, pinned                                                */
/* -------------------------------------------------------------------------- */

const ALLOWED = [
  "GET /workspaces",
  "POST /actions/linkedin-search-company-employees/run/live",
  "POST /actions/linkedin-extract-contact/run/live",
].sort();

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("the endpoint surface", () => {
  it("is exactly the pinned list, read from the source", () => {
    const sites = [...source.matchAll(/\bcall<[\s\S]*?>\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)].map(([, method, path]) => {
      const bare = path!.slice(1, -1).replace(/\$\{[^}]*\}/g, "").split("?")[0];
      return `${method} ${bare}`;
    });
    // Every `call<` but the definition itself must be one the pattern reads.
    assert.equal(sites.length, (source.match(/\bcall</g) ?? []).length - 1, "a call site is written in a form this test cannot read");
    assert.deepEqual([...new Set(sites)].sort(), ALLOWED);
    assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1, "fetch is called outside `call`");
  });
});

after(() => {
  for (const res of hung.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
  const seenEndpoints = [...new Set(everyRequest.map((r) => `${r.method} ${r.path}`))].sort();
  assert.deepEqual(seenEndpoints.filter((e) => !ALLOWED.includes(e)), [], "a request left the pinned endpoint surface");
  assert.deepEqual(seenEndpoints, ALLOWED, "the suite did not exercise every pinned endpoint");
});
