/**
 * Tests for the Attio adapters — crm and inbound — against a fake of the API.
 *
 * The fake answers in the shapes Attio's OpenAPI document gives, records every
 * request, and holds no real data: the contract's shape and its fail-closed
 * behaviour are what this proves. Reading a real workspace is integration,
 * done with the owner (CLAUDE.md §5: this file is the seam, not the crossing).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";

import { retryAfterMs } from "./client.js";
import crmFactory from "./crm/index.js";
import inboundFactory from "./inbound/index.js";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

const state = {
  people: [] as { id: string; email: string; name?: string }[],
  companies: [] as { id: string; domain: string; name?: string }[],
  notes: [] as { parent: string; created_at: string; content_plaintext: string }[],
  meetings: [] as { id: { meeting_id: string }; created_at: string; participants: { email_address: string; is_organizer: boolean; status: string }[] }[],
  meetingPageSize: 2,
  active: true,
  /** When set, the fake never answers. */
  hang: false,
  forceStatus: 0,
};
let seen: Seen[] = [];
/** Requests the fake left unanswered on purpose; answered once their test is over. */
const hung: import("node:http").ServerResponse[] = [];
const everyRequest: Seen[] = [];
let server: Server;
let baseUrl = "";

const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b));
  });

const record = (object: string, id: string, values: Record<string, unknown[]>) => ({
  id: { record_id: id },
  web_url: `https://app.example.invalid/${object}/${id}`,
  values,
});
const person = (p: { id: string; email: string; name?: string }) =>
  record("people", p.id, { email_addresses: [{ email_address: p.email }], ...(p.name ? { name: [{ full_name: p.name }] } : {}) });
const company = (c: { id: string; domain: string; name?: string }) =>
  record("companies", c.id, { domains: [{ domain: c.domain }], ...(c.name ? { name: [{ value: c.name }] } : {}) });

before(async () => {
  server = createServer(async (req, res) => {
    // A handler that throws would leave the request unanswered and the suite
    // hanging; it answers 500 instead, so a broken assumption fails a test.
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

async function handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  {
    const url = new URL(req.url ?? "/", "http://fake");
    const text = await read(req);
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    const entry = { method: req.method ?? "", path: url.pathname + url.search, ...(body ? { body } : {}) };
    seen.push(entry);
    everyRequest.push({ method: entry.method, path: url.pathname });
    const reply = (status: number, value?: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (state.hang) {
      hung.push(res); // never answers while the test runs
      return;
    }
    if (state.forceStatus === 429) return reply(429, { message: "slow down" }, { "retry-after": new Date(Date.now() + 30_000).toUTCString() });
    if (state.forceStatus) return reply(state.forceStatus, { message: "forced" });

    const p = url.pathname;
    if (req.method === "GET" && p === "/v2/self") return reply(200, { active: state.active });
    if (req.method === "POST" && p === "/v2/objects/people/records/query") {
      const want = (body?.filter as { email_addresses: { email_address: { $eq: string } } }).email_addresses.email_address.$eq;
      return reply(200, { data: state.people.filter((x) => x.email === want).map(person) });
    }
    if (req.method === "POST" && p === "/v2/objects/companies/records/query") {
      const want = (body?.filter as { domains: { domain: { $eq: string } } }).domains.domain.$eq;
      return reply(200, { data: state.companies.filter((x) => x.domain === want).map(company) });
    }
    if (req.method === "PUT" && p === "/v2/objects/companies/records") {
      const values = (body?.data as { values: { domains: string[]; name?: string } }).values;
      let c = state.companies.find((x) => x.domain === values.domains[0]);
      if (!c) state.companies.push((c = { id: `c${state.companies.length + 1}`, domain: values.domains[0]!, ...(values.name ? { name: values.name } : {}) }));
      return reply(200, { data: company(c) });
    }
    if (req.method === "PUT" && p === "/v2/objects/people/records") {
      const values = (body?.data as { values: { email_addresses: string[] } }).values;
      let x = state.people.find((y) => y.email === values.email_addresses[0]);
      if (!x) state.people.push((x = { id: `p${state.people.length + 1}`, email: values.email_addresses[0]! }));
      return reply(200, { data: person(x) });
    }
    if (req.method === "GET" && p === "/v2/notes") {
      const parent = `${url.searchParams.get("parent_object")}:${url.searchParams.get("parent_record_id")}`;
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return reply(200, { data: state.notes.filter((n) => n.parent === parent).slice(offset, offset + limit) });
    }
    if (req.method === "POST" && p === "/v2/notes") {
      const d = body?.data as { parent_object: string; parent_record_id: string; created_at: string; content: string };
      state.notes.push({ parent: `${d.parent_object}:${d.parent_record_id}`, created_at: d.created_at, content_plaintext: d.content });
      return reply(200, { data: {} });
    }
    if (req.method === "GET" && p === "/v2/meetings") {
      const endsFrom = url.searchParams.get("ends_from");
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const all = endsFrom ? state.meetings.filter((m) => m.created_at >= endsFrom) : state.meetings;
      const page = all.slice(start, start + state.meetingPageSize);
      const next = start + state.meetingPageSize < all.length ? String(start + state.meetingPageSize) : null;
      return reply(200, { data: page, pagination: { next_cursor: next } });
    }
    return reply(404, { message: `fake has no ${req.method} ${p}` });
  }
}

beforeEach(() => {
  // No connection is left open across tests: an unanswered request from one
  // test must not hold the next one, or the end of the file, hostage.
  for (const res of hung.splice(0)) res.destroy();
  state.people = [];
  state.companies = [];
  state.notes = [];
  state.meetings = [];
  state.meetingPageSize = 2;
  state.active = true;
  state.hang = false;
  state.forceStatus = 0;
  seen = [];
});

const ctx = (dryRun: boolean): CallContext => ({ runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" }, dryRun });
const writes = () => seen.filter((s) => s.method === "PUT" || (s.method === "POST" && !s.path.endsWith("/records/query")));
const crm = (token: string | null = "test-token") => crmFactory({ options: { baseUrl }, env: token === null ? {} : { ATTIO_API_KEY: token } });
const inbound = (internalDomains = "") => inboundFactory({ options: { baseUrl, internalDomains }, env: { ATTIO_API_KEY: "test-token" } });

describe("the shared client", () => {
  it("probes with /v2/self, and calls an inactive token a refusal, not health", async () => {
    assert.equal((await crm().probe!(ctx(true))).ok, true);
    state.active = false;
    const r = await crm().probe!(ctx(true));
    assert.ok(!r.ok && r.error.code === "unauthorized");
  });

  it("fails without a token, calling nobody", async () => {
    assert.equal((await crm(null).probe!(ctx(true))).ok, false);
    assert.equal(seen.length, 0);
  });

  it("turns a 429's Retry-After date into a wait", async () => {
    state.forceStatus = 429;
    const r = await crm().findPersonByEmail("ada@example.com", ctx(true));
    assert.ok(!r.ok && r.error.code === "rate_limited" && r.error.retryable);
    if (!r.ok) assert.ok((r.error.retryAfterMs ?? 0) > 20_000 && (r.error.retryAfterMs ?? 0) <= 30_000, String(r.error.retryAfterMs));
    assert.equal(retryAfterMs("Tue, 23 May 2023 14:42:01 GMT", Date.parse("Tue, 23 May 2023 14:42:00 GMT")), 1000);
  });

  it("gives up on a provider that never answers, rather than hanging the run", async () => {
    state.hang = true;
    const slow = crmFactory({ options: { baseUrl, timeoutMs: 200 }, env: { ATTIO_API_KEY: "test-token" } });
    const started = Date.now();
    const r = await slow.probe!(ctx(true));
    assert.ok(!r.ok && r.error.code === "unavailable" && /no answer within 200 ms/.test(r.error.message), JSON.stringify(r));
    assert.ok(Date.now() - started < 5_000);
  });

  it("calls a missing scope unauthorized", async () => {
    state.forceStatus = 403;
    const r = await crm().findCompanyByDomain("example.com", ctx(true));
    assert.ok(!r.ok && r.error.code === "unauthorized");
  });
});

describe("crm", () => {
  const registration = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: "k1",
    reason: "reply_received" as const,
    occurredAt: "2026-01-02T03:04:05.000Z",
    person: { email: "Ada@Example.com", fullName: "Ada King Lovelace" },
    company: { domain: "example.com", name: "Example" },
    ...over,
  });

  it("finds with Attio's verbose filters, and reads no-match as null", async () => {
    state.people.push({ id: "p1", email: "ada@example.com", name: "Ada" });
    const found = await crm().findPersonByEmail("ADA@example.com", ctx(true));
    assert.ok(found.ok && found.value?.email === "ada@example.com" && found.value.ref.externalId === "people:p1");
    const none = await crm().findCompanyByDomain("nobody.example.org", ctx(true));
    assert.ok(none.ok && none.value === null);
    assert.deepEqual(seen[0]?.body, { filter: { email_addresses: { email_address: { $eq: "ada@example.com" } } }, limit: 1 });
  });

  it("returns an existing person as existed, writing nothing", async () => {
    state.people.push({ id: "p1", email: "ada@example.com" });
    const r = await crm().register(registration(), ctx(false));
    assert.ok(r.ok && r.value.existed);
    assert.deepEqual(writes(), []);
  });

  it("in dry run, reads and writes nothing", async () => {
    const r = await crm().register(registration(), ctx(true));
    assert.ok(r.ok && r.simulated && !r.value.existed);
    assert.deepEqual(writes(), []);
  });

  it("upserts the company on its domain and the person on their address, linked", async () => {
    const r = await crm().register(registration(), ctx(false));
    assert.ok(r.ok && !r.value.existed, JSON.stringify(r));
    const puts = writes().map((w) => w.path);
    assert.deepEqual(puts, ["/v2/objects/companies/records?matching_attribute=domains", "/v2/objects/people/records?matching_attribute=email_addresses"]);
    const values = (writes()[1]?.body?.data as { values: Record<string, unknown> }).values;
    assert.deepEqual(values.email_addresses, ["ada@example.com"]);
    assert.deepEqual(values.company, [{ target_object: "companies", target_record_id: "c1" }]);
  });

  it("is safe to replay: the second call finds the person and writes nothing", async () => {
    await crm().register(registration(), ctx(false));
    seen = [];
    const again = await crm().register(registration(), ctx(false));
    assert.ok(again.ok && again.value.existed);
    assert.deepEqual(writes(), []);
    assert.equal(state.people.length, 1);
  });

  it("refuses a registration without an address", async () => {
    const r = await crm().register(registration({ person: { fullName: "No Address" } }), ctx(false));
    assert.ok(!r.ok && r.error.code === "invalid");
  });

  describe("annotate", () => {
    const note = (over: Record<string, unknown> = {}) => ({
      idempotencyKey: "n1",
      subject: { externalId: "people:p1" },
      body: "Replied to the second step.",
      occurredAt: "2026-01-02T03:04:05.000Z",
      ...over,
    });

    it("writes a note backdated to when it happened", async () => {
      const r = await crm().annotate(note(), ctx(false));
      assert.equal(r.ok, true);
      const post = writes()[0]?.body?.data as Record<string, unknown>;
      assert.deepEqual([post.parent_object, post.parent_record_id, post.created_at, post.format], ["people", "p1", "2026-01-02T03:04:05.000Z", "plaintext"]);
    });

    it("does not write the same note twice — found even on a later page", async () => {
      for (let i = 0; i < 60; i++) state.notes.push({ parent: "people:p1", created_at: `2025-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, content_plaintext: `other ${i}` });
      state.notes.push({ parent: "people:p1", created_at: "2026-01-02T03:04:05.000Z", content_plaintext: "Replied to the second step." });
      const r = await crm().annotate(note(), ctx(false));
      assert.equal(r.ok, true);
      assert.deepEqual(writes(), []);
    });

    it("in dry run, writes nothing", async () => {
      assert.equal((await crm().annotate(note(), ctx(true))).ok, true);
      assert.deepEqual(writes(), []);
    });

    it("refuses a reference it did not make", async () => {
      const r = await crm().annotate(note({ subject: { externalId: "p1" } }), ctx(false));
      assert.ok(!r.ok && r.error.code === "invalid");
    });
  });
});

describe("inbound", () => {
  const meeting = (id: string, created: string, ...participants: [string, boolean, string][]) => ({
    id: { meeting_id: id },
    created_at: created,
    participants: participants.map(([email_address, is_organizer, status]) => ({ email_address, is_organizer, status })),
  });

  it("emits one booked meeting per external participant, and skips the organiser, the declined and the internal", async () => {
    state.meetings.push(
      // The organiser is on a domain not listed as internal, so only the
      // organiser rule can keep them out — the rules must not mask each other.
      meeting("m1", "2026-01-01T10:00:00Z", ["host@example.net", true, "accepted"], ["ada@example.org", false, "accepted"], ["bo@example.net", false, "declined"]),
      meeting("m2", "2026-01-01T11:00:00Z", ["colleague@example.com", false, "accepted"]),
    );
    const r = await inbound("example.com").events({}, ctx(true));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.value.items.map((e) => [e.providerEventId, e.type, e.occurredAt]), [["m1:ada@example.org", "gtm.meeting_booked", "2026-01-01T10:00:00Z"]]);
  });

  it("pages through, then resumes from when the read began, and the ids stay stable across reads", async () => {
    state.meetings.push(
      meeting("m1", "2026-01-01T10:00:00Z", ["a@example.org", false, "accepted"]),
      meeting("m2", "2026-01-01T11:00:00Z", ["b@example.org", false, "accepted"]),
      meeting("m3", "2026-01-01T12:00:00Z", ["c@example.org", false, "accepted"]),
    );
    const source = inbound();
    const first = await source.events({}, ctx(true));
    assert.ok(first.ok);
    if (!first.ok) return;
    const second = await source.events({ after: first.value.cursor }, ctx(true));
    assert.ok(second.ok);
    if (!second.ok) return;
    assert.deepEqual([...first.value.items, ...second.value.items].map((e) => e.providerEventId), ["m1:a@example.org", "m2:b@example.org", "m3:c@example.org"]);
    assert.match(seen[1]?.path ?? "", /cursor=2/);
    const third = await source.events({ after: second.value.cursor }, ctx(true));
    assert.ok(third.ok);
    assert.match(seen[2]?.path ?? "", /ends_from=/, "the next read starts from when the last one began");
  });

  it("returns a cursor even when nothing is new", async () => {
    const r = await inbound().events({}, ctx(true));
    assert.ok(r.ok && r.value.items.length === 0 && typeof r.value.cursor === "string" && r.value.cursor.length > 0);
  });

  it("is an error, never an empty page, when Attio cannot be read", async () => {
    state.forceStatus = 503;
    const r = await inbound().events({}, ctx(true));
    assert.ok(!r.ok && r.error.code === "unavailable");
  });

  it("refuses a cursor it did not make", async () => {
    const r = await inbound().events({ after: "not-a-cursor" }, ctx(true));
    assert.ok(!r.ok && r.error.code === "invalid");
  });
});

/* -------------------------------------------------------------------------- */
/* The endpoint surface, pinned — both adapters, one list                       */
/* -------------------------------------------------------------------------- */

const ALLOWED = [
  "GET /v2/self",
  "POST /v2/objects/{}/records/query",
  "PUT /v2/objects/companies/records",
  "PUT /v2/objects/people/records",
  "GET /v2/notes",
  "POST /v2/notes",
  "GET /v2/meetings",
].sort();

const sources = ["./client.ts", "./crm/index.ts", "./inbound/index.ts"].map((f) => readFileSync(new URL(f, import.meta.url), "utf8"));

describe("the endpoint surface", () => {
  it("is exactly the pinned list, read from the source — including paths no test exercises", () => {
    const all = sources.join("\n");
    const sites = [...all.matchAll(/\bcall<[\s\S]*?>\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)].map(([, method, path]) => {
      const bare = path!.slice(1, -1).replace(/\$\{[^}]*\}/g, "{}").split("?")[0];
      return `${method} ${bare}`;
    });
    // Every `call<` after the definition must be one the pattern reads.
    const callSites = (all.match(/\bcall</g) ?? []).length;
    assert.equal(sites.length, callSites, "a call site is written in a form this test cannot read");
    assert.deepEqual([...new Set(sites)].sort(), ALLOWED);
    assert.equal((all.match(/\bfetch\(/g) ?? []).length, 1, "fetch is called outside the shared client");
  });
});

/** Every request of the run stayed on the list, and the run exercised all of it (as for the email adapter). */
after(() => {
  for (const res of hung.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
  const shape = (path: string) => path.replace(/^\/v2\/objects\/(people|companies)\/records\/query$/, "/v2/objects/{}/records/query");
  const seenEndpoints = [...new Set(everyRequest.map((r) => `${r.method} ${shape(r.path)}`))].sort();
  assert.deepEqual(seenEndpoints.filter((e) => !ALLOWED.includes(e)), [], "a request left the pinned endpoint surface");
  assert.deepEqual(seenEndpoints, ALLOWED, "the suite did not exercise every pinned endpoint");
});
