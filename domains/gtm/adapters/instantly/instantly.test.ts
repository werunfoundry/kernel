/**
 * Tests for the Instantly adapter, against a fake of the API.
 *
 * The fake answers in the shapes Instantly's OpenAPI document gives, and
 * records every request, so each test can say what was asked as well as what
 * came back. That is a seam, and CLAUDE.md §5 says what a seam hides: the real
 * API. The crossing is `pnpm verify` against a real workspace, which is how
 * this adapter is accepted — this file only pins the logic between the two.
 *
 * One assertion runs through all of it: a dry run writes nothing. Instantly
 * sends email to real people, and the dry-run tests check the request log for
 * any write, not just the result.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";

import type { Sequencer } from "../../contracts/sequencer.js";
import factory from "./index.js";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/** The fake's state: what Instantly would hold. */
const state = {
  leads: [] as { id: string; email: string; campaign: string; status: number; payload?: Record<string, unknown> }[],
  blocklist: [] as string[],
  accounts: { "sender@example.com": { daily_limit: 40, status: 1 } } as Record<string, { daily_limit: number; status: number }>,
  sentToday: 15,
  /** When set, every response is this status. */
  forceStatus: 0,
  /** When set, the next lead lookup finds nothing — a read that loses a race. */
  missNextList: false,
};
let seen: Seen[] = [];
/** Every request of the whole run. `seen` is reset per test; this never is. */
const everyRequest: Seen[] = [];
let server: Server;
let baseUrl = "";

const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => done(body));
  });

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const text = await read(req);
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    seen.push({ method: req.method ?? "", path: url.pathname + url.search, ...(body ? { body } : {}), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    everyRequest.push({ method: req.method ?? "", path: url.pathname });
    const reply = (status: number, value?: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (state.forceStatus) return reply(state.forceStatus, { message: "forced" });

    const p = url.pathname;
    if (req.method === "GET" && p === "/api/v2/campaigns") return reply(200, { items: [{ id: "c1" }] });
    if (req.method === "GET" && p.startsWith("/api/v2/campaigns/")) {
      return p.endsWith("/c1") ? reply(200, { id: "c1", status: 1 }) : reply(404, { message: "not found" });
    }
    if (req.method === "POST" && p === "/api/v2/leads/list") {
      if (state.missNextList) {
        state.missNextList = false;
        return reply(200, { items: [], next_starting_after: null });
      }
      const emails = ((body?.contacts as string[]) ?? []).map((e) => e.toLowerCase());
      const items = state.leads.filter((l) => l.campaign === body?.campaign && emails.includes(l.email.toLowerCase()));
      return reply(200, { items, next_starting_after: null });
    }
    if (req.method === "POST" && p === "/api/v2/leads/add") {
      const lead = (body?.leads as { email: string; custom_variables?: Record<string, unknown> }[])[0]!;
      const domain = lead.email.split("@")[1]!;
      if (state.blocklist.includes(lead.email) || state.blocklist.includes(domain)) {
        return reply(200, { leads_uploaded: 0, in_blocklist: 1, duplicated_leads: 0, created_leads: [] });
      }
      if (state.leads.some((l) => l.campaign === body?.campaign_id && l.email === lead.email)) {
        return reply(200, { leads_uploaded: 0, in_blocklist: 0, duplicated_leads: 1, created_leads: [] });
      }
      const id = `lead-${state.leads.length + 1}`;
      state.leads.push({ id, email: lead.email, campaign: String(body?.campaign_id), status: 1, ...(lead.custom_variables ? { payload: lead.custom_variables } : {}) });
      return reply(200, { leads_uploaded: 1, in_blocklist: 0, duplicated_leads: 0, created_leads: [{ index: 0, id }] });
    }
    if (req.method === "DELETE" && p.startsWith("/api/v2/leads/")) {
      const id = p.split("/").pop();
      const at = state.leads.findIndex((l) => l.id === id);
      if (at === -1) return reply(404, { message: "not found" });
      return reply(200, state.leads.splice(at, 1)[0]);
    }
    if (req.method === "GET" && p === "/api/v2/block-lists-entries") {
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return reply(200, { items: state.blocklist.filter((v) => v.includes(q)).map((bl_value) => ({ bl_value })) });
    }
    if (req.method === "POST" && p === "/api/v2/block-lists-entries") {
      state.blocklist.push(String(body?.bl_value));
      return reply(200, { id: "bl1", bl_value: body?.bl_value });
    }
    if (req.method === "GET" && p.startsWith("/api/v2/accounts/analytics/daily")) {
      const email = url.searchParams.get("emails") ?? "";
      return reply(200, [{ date: url.searchParams.get("start_date"), email_account: email, sent: state.sentToday }]);
    }
    if (req.method === "GET" && p.startsWith("/api/v2/accounts/")) {
      const email = decodeURIComponent(p.split("/").pop() ?? "");
      const account = state.accounts[email];
      return account ? reply(200, { email, ...account }) : reply(404, { message: "not found" });
    }
    return reply(404, { message: `fake has no ${req.method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  state.leads = [];
  state.blocklist = [];
  state.forceStatus = 0;
  state.missNextList = false;
  state.sentToday = 15;
  state.accounts["sender@example.com"] = { daily_limit: 40, status: 1 };
  seen = [];
});

/** `null` for no key at all — `undefined` would take the default. */
const adapter = (token: string | null = "test-key"): Sequencer =>
  factory({ options: { baseUrl, "campaign.welcome": "c1" }, env: token === null ? {} : { INSTANTLY_API_KEY: token } });

const ctx = (dryRun: boolean): CallContext => ({ runId: "run-1", actor: { type: "system" }, dryRun });
const writes = () => seen.filter((s) => s.method === "DELETE" || (s.method === "POST" && s.path !== "/api/v2/leads/list"));

const enrolment = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: "k1",
  sequenceKey: "welcome",
  person: { email: "ada@example.com", fullName: "Ada King Lovelace" },
  attribution: { runId: "run-1", experimentSlug: "exp", variant: "a" },
  ...over,
});

describe("probe", () => {
  it("lists one campaign with the key as a bearer token", async () => {
    const r = await adapter().probe!(ctx(true));
    assert.equal(r.ok, true);
    assert.deepEqual(seen.map((s) => [s.method, s.path, s.auth]), [["GET", "/api/v2/campaigns?limit=1", "Bearer test-key"]]);
  });

  it("reports a refused key as unauthorized", async () => {
    state.forceStatus = 401;
    const r = await adapter().probe!(ctx(true));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "unauthorized");
  });

  it("fails without a key, without calling anyone", async () => {
    const r = await adapter(null).probe!(ctx(true));
    assert.equal(r.ok, false);
    assert.equal(seen.length, 0);
  });
});

describe("enrol", () => {
  it("in dry run, reads and writes nothing", async () => {
    const r = await adapter().enrol(enrolment(), ctx(true));
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.equal(r.simulated, true);
    assert.deepEqual(writes(), []);
    assert.equal(state.leads.length, 0);
  });

  it("in dry run, says a blocklisted domain would be skipped", async () => {
    state.blocklist.push("example.com");
    const r = await adapter().enrol(enrolment(), ctx(true));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /blocklist/);
    assert.deepEqual(writes(), []);
  });

  it("creates the lead in the mapped campaign, carrying the key and the attribution", async () => {
    const r = await adapter().enrol(enrolment(), ctx(false));
    assert.equal(r.ok, true, JSON.stringify(r));
    const add = seen.find((s) => s.path === "/api/v2/leads/add");
    assert.equal(add?.body?.campaign_id, "c1");
    const lead = (add?.body?.leads as Record<string, unknown>[])[0]!;
    assert.deepEqual([lead.first_name, lead.last_name], ["Ada", "King Lovelace"]);
    assert.deepEqual(lead.custom_variables, {
      engine_idempotency_key: "k1",
      engine_run_id: "run-1",
      engine_experiment: "exp",
      engine_variant: "a",
    });
  });

  it("returns the same enrolment when replayed with the same key, and writes once", async () => {
    await adapter().enrol(enrolment(), ctx(false));
    const again = await adapter().enrol(enrolment(), ctx(false));
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(seen.filter((s) => s.path === "/api/v2/leads/add").length, 1);
  });

  it("is a conflict under another key, never a silent success", async () => {
    await adapter().enrol(enrolment(), ctx(false));
    const other = await adapter().enrol(enrolment({ idempotencyKey: "k2" }), ctx(false));
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error.code, "conflict");
  });

  it("decides by the key when Instantly reports a duplicate it raced with", async () => {
    // Enrolled between our read and our write — by a replay of this very
    // call: the lead exists, our first read misses it, the upload reports a
    // duplicate.
    state.leads.push({ id: "lead-x", email: "ada@example.com", campaign: "c1", status: 1, payload: { engine_idempotency_key: "k1" } });
    state.missNextList = true;
    const r = await adapter().enrol(enrolment(), ctx(false));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(seen.filter((s) => s.path === "/api/v2/leads/list").length, 2);
    assert.equal(state.leads.length, 1);
  });

  it("refuses an explicit sender rather than sending from someone else", async () => {
    const r = await adapter().enrol(enrolment({ sender: { externalId: "sender@example.com" } }), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid");
    assert.deepEqual(writes(), []);
  });

  it("refuses a sequence with no campaign mapped", async () => {
    const r = await adapter().enrol(enrolment({ sequenceKey: "nowhere" }), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /campaign\.nowhere/);
  });
});

describe("withdraw", () => {
  const request = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: "w1",
    person: { email: "ada@example.com" },
    sequenceKey: "welcome",
    reason: "experiment ended",
    ...over,
  });

  it("deletes the lead from that campaign", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1 });
    const r = await adapter().withdraw(request(), ctx(false));
    assert.equal(r.ok, true);
    assert.equal(state.leads.length, 0);
    assert.ok(seen.some((s) => s.method === "DELETE" && s.path === "/api/v2/leads/lead-1"));
  });

  it("succeeds for someone not enrolled", async () => {
    const r = await adapter().withdraw(request(), ctx(false));
    assert.equal(r.ok, true);
    assert.deepEqual(writes(), []);
  });

  it("in dry run, deletes nothing", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1 });
    const r = await adapter().withdraw(request(), ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.simulated, true);
    assert.deepEqual(writes(), []);
    assert.equal(state.leads.length, 1);
  });
});

describe("suppress", () => {
  const request = (target: { email: string } | { domain: string }) => ({ idempotencyKey: "s1", target, reason: "protected" });

  it("blocklists a whole domain, in Instantly's format", async () => {
    const r = await adapter().suppress(request({ domain: "@Example.ORG" }), ctx(false));
    assert.equal(r.ok, true);
    assert.deepEqual(state.blocklist, ["example.org"]);
  });

  it("writes nothing for a target already blocked", async () => {
    state.blocklist.push("ada@example.com");
    const r = await adapter().suppress(request({ email: "ada@example.com" }), ctx(false));
    assert.equal(r.ok, true);
    assert.deepEqual(writes(), []);
  });

  it("in dry run, writes nothing", async () => {
    const r = await adapter().suppress(request({ domain: "example.org" }), ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.simulated, true);
    assert.deepEqual(writes(), []);
    assert.deepEqual(state.blocklist, []);
  });
});

describe("status", () => {
  it("reads an opt-out as unsubscribed, not as stopped", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: -2 });
    const r = await adapter().status({ person: { email: "ada@example.com" }, sequenceKey: "welcome" }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.state, "unsubscribed");
  });

  it("reads no enrolment as unknown, not as an error", async () => {
    const r = await adapter().status({ person: { email: "nobody@example.com" }, sequenceKey: "welcome" }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.state, "unknown");
  });
});

describe("capacity", () => {
  it("is the daily limit less what the account sent today", async () => {
    const r = await adapter().capacity({ externalId: "sender@example.com" }, ctx(true));
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.deepEqual([r.value.dailyLimit, r.value.usedToday, r.value.remainingToday], [40, 15, 25]);
  });

  it("is nothing left for an account that is not active", async () => {
    state.accounts["sender@example.com"] = { daily_limit: 40, status: 2 };
    const r = await adapter().capacity({ externalId: "sender@example.com" }, ctx(true));
    if (r.ok) assert.equal(r.value.remainingToday, 0);
  });

  it("maps the workspace rate limit to a retryable error", async () => {
    state.forceStatus = 429;
    const r = await adapter().capacity({ externalId: "sender@example.com" }, ctx(true));
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual([r.error.code, r.error.retryable], ["rate_limited", true]);
  });
});

/* -------------------------------------------------------------------------- */
/* The endpoint surface, pinned                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every endpoint this adapter may call, and no other. `{}` stands for one
 * path segment the adapter fills in; query strings are not part of the
 * surface.
 *
 * The API this adapter talks to can empty the whole workspace blocklist in one
 * call (`DELETE /api/v2/block-lists-entries`) — the blocklist that is defence
 * in depth for protected accounts (0012). Today nothing here can do that: the
 * only delete is one lead, the only blocklist write is one entry. This list is
 * what keeps it so. Adding an endpoint is a change to this list, made on
 * purpose and seen in review — never a side effect of a new method.
 */
const ALLOWED = [
  "GET /api/v2/campaigns",
  "GET /api/v2/campaigns/{}",
  "POST /api/v2/leads/list",
  "POST /api/v2/leads/add",
  "DELETE /api/v2/leads/{}",
  "GET /api/v2/block-lists-entries",
  "POST /api/v2/block-lists-entries",
  "GET /api/v2/accounts/{}",
  "GET /api/v2/accounts/analytics/daily",
].sort();

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("the endpoint surface", () => {
  it("is exactly the pinned list, read from the source — including paths no test exercises", () => {
    // `call<T>("METHOD", "path" | `path`, …)`. A template expression stands
    // for one segment; the query string is dropped.
    const sites = [...source.matchAll(/\bcall<[\s\S]*?>\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)].map(([, method, path]) => {
      const bare = path!.slice(1, -1).replace(/\$\{[^}]*\}/g, "{}").split("?")[0];
      return `${method} ${bare}`;
    });
    // Every call site must be one the pattern above can read. A call written
    // another way would be invisible to it, so it is refused rather than
    // missed: the count of `call<` must match what was read, less the
    // definition itself.
    const callSites = (source.match(/\bcall</g) ?? []).length - 1;
    assert.equal(sites.length, callSites, "a call site is written in a form this test cannot read");
    assert.deepEqual([...new Set(sites)].sort(), ALLOWED);
    // And nothing reaches the network except through `call`.
    assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1, "fetch is called outside `call`");
  });

  it("is never left by any request the suite made", () => {
    const shape = (path: string) =>
      path.replace(/^\/api\/v2\/(campaigns|leads|accounts)\/(?!list$|add$|analytics\/daily$)[^/]+$/, "/api/v2/$1/{}");
    const outside = everyRequest.map((r) => `${r.method} ${shape(r.path)}`).filter((e) => !ALLOWED.includes(e));
    assert.ok(everyRequest.length > 0, "no request was recorded; this test would pass by seeing nothing");
    assert.deepEqual([...new Set(outside)], []);
  });
});
