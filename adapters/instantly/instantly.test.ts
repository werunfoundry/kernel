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
import type { Identity } from "@werunfoundry/core/identity";

import type { Sequencer } from "@werunfoundry/acquisition/contracts/sequencer";
import { checkDeclaration, readDeclaration } from "@werunfoundry/acquisition/contracts/sequencer";
import factory from "./index.js";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/** The fake's state: what Instantly would hold. */
const state = {
  leads: [] as { id: string; email: string; campaign: string; status: number; payload?: Record<string, unknown>; subsequence_id?: string; timestamp_updated?: string }[],
  /** Subsequences by id, with the campaign each belongs to. */
  subsequences: { s1: { parent_campaign: "c1" }, s9: { parent_campaign: "c9" } } as Record<string, { parent_campaign: string }>,
  /** When set, a move answers 200 and moves nothing — what a status write did live (README). */
  moveDoesNothing: false,
  /** When set, an upload answers `leads_uploaded: 1` and stores nothing — a success that did nothing. */
  addDoesNothing: false,
  blocklist: [] as string[],
  /** When set, a blocklist write answers 200 and stores nothing — a success that did nothing. */
  blockDoesNothing: false,
  accounts: { "sender@example.com": { daily_limit: 40, status: 1 } } as Record<string, { daily_limit: number; status: number }>,
  sentToday: 15,
  /** When set, every response is this status. */
  forceStatus: 0,
  /** When set, the fake never answers. */
  hang: false,
  /** When set, the next lead lookup finds nothing — a read that loses a race. */
  missNextList: false,
};
let seen: Seen[] = [];
/** Requests left unanswered on purpose; closed once their test is over. */
const hung: import("node:http").ServerResponse[] = [];
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
    if (state.hang) {
      hung.push(res); // never answers while the test runs
      return;
    }
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
      if (state.addDoesNothing) return reply(200, { leads_uploaded: 1, in_blocklist: 0, duplicated_leads: 0, created_leads: [{ index: 0, id }] });
      state.leads.push({ id, email: lead.email, campaign: String(body?.campaign_id), status: 1, ...(lead.custom_variables ? { payload: lead.custom_variables } : {}) });
      return reply(200, { leads_uploaded: 1, in_blocklist: 0, duplicated_leads: 0, created_leads: [{ index: 0, id }] });
    }
    if (req.method === "POST" && p === "/api/v2/leads/subsequence/move") {
      const lead = state.leads.find((l) => l.id === body?.id);
      if (!lead) return reply(404, { message: "not found" });
      if (!state.moveDoesNothing) lead.subsequence_id = String(body?.subsequence_id);
      return reply(200, { ...lead });
    }
    if (req.method === "GET" && p.startsWith("/api/v2/leads/")) {
      const lead = state.leads.find((l) => l.id === p.split("/").pop());
      return lead ? reply(200, { ...lead, status_summary: { lastStep: { stepID: "0_0_0" } } }) : reply(404, { message: "not found" });
    }
    if (req.method === "GET" && p.startsWith("/api/v2/subsequences/")) {
      const id = p.split("/").pop() ?? "";
      const sub = state.subsequences[id];
      return sub ? reply(200, { id, ...sub }) : reply(404, { message: "not found" });
    }
    if (req.method === "GET" && p === "/api/v2/block-lists-entries") {
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return reply(200, { items: state.blocklist.filter((v) => v.includes(q)).map((bl_value) => ({ bl_value })) });
    }
    if (req.method === "POST" && p === "/api/v2/block-lists-entries") {
      if (!state.blockDoesNothing) state.blocklist.push(String(body?.bl_value));
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

after(() => {
  for (const res of hung.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  for (const res of hung.splice(0)) res.destroy();
  state.hang = false;
  state.leads = [];
  state.blocklist = [];
  state.forceStatus = 0;
  state.missNextList = false;
  state.moveDoesNothing = false;
  state.addDoesNothing = false;
  state.blockDoesNothing = false;
  state.sentToday = 15;
  state.accounts["sender@example.com"] = { daily_limit: 40, status: 1 };
  seen = [];
});

/** `null` for no key at all — `undefined` would take the default. */
const adapter = (token: string | null = "test-key", options: Record<string, string> = { "subsequence.welcome": "s1" }): Sequencer =>
  factory({ options: { baseUrl, "campaign.welcome": "c1", ...options }, env: token === null ? {} : { INSTANTLY_API_KEY: token } });

const ctx = (dryRun: boolean): CallContext => ({ runId: "run-1", actor: { type: "system" }, dryRun });
const writes = () => seen.filter((s) => s.method === "DELETE" || s.method === "PATCH" || (s.method === "POST" && s.path !== "/api/v2/leads/list"));

/** A person reachable by email, as the engine hands one over (decision 0013). */
const ada = (email = "ada@example.com"): Identity => ({ subject: "person", keys: [{ kind: "email", value: email }] });

const enrolment = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: "k1",
  sequenceKey: "welcome",
  channel: "email",
  person: ada(),
  display: { fullName: "Ada King Lovelace" },
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

  it("gives up on a provider that never answers, rather than hanging the run", async () => {
    state.hang = true;
    const slow = factory({ options: { baseUrl, timeoutMs: 200 }, env: { INSTANTLY_API_KEY: "test-key" } });
    const started = Date.now();
    const r = await slow.probe!(ctx(true));
    assert.ok(!r.ok && r.error.code === "unavailable" && /no answer within 200 ms/.test(r.error.message), JSON.stringify(r));
    assert.ok(Date.now() - started < 5_000);
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
    // Read back (0051): the lead is read again after the upload.
    const uploaded = seen.findIndex((s) => s.path === "/api/v2/leads/add");
    assert.ok(seen.slice(uploaded + 1).some((s) => s.path === "/api/v2/leads/list"), "the lead was not read back after the upload");
  });

  it("is an error, not a success, when Instantly reports the lead uploaded and it does not read back", async () => {
    state.addDoesNothing = true;
    const r = await adapter().enrol(enrolment(), ctx(false));
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) {
      assert.equal(r.error.code, "unknown");
      assert.match(r.error.message, /does not read back/);
    }
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

  it("refuses a channel it does not serve, before calling anyone", async () => {
    const r = await adapter().enrol(enrolment({ channel: "social_message" }), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /channel "email" only/);
    assert.equal(seen.length, 0);
  });

  it("refuses a person it has no address for, rather than enrolling a guess", async () => {
    const r = await adapter().enrol(
      enrolment({ person: { subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-1" }] } }),
      ctx(false),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid");
    assert.equal(seen.length, 0);
  });

  it("refuses a sequence with no campaign mapped", async () => {
    const r = await adapter().enrol(enrolment({ sequenceKey: "nowhere" }), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /campaign\.nowhere/);
  });
});

describe("withdraw (decision 0051)", () => {
  const request = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: "w1",
    person: ada(),
    sequenceKey: "welcome",
    reason: "experiment ended",
    ...over,
  });
  const enrolled = () => state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1 });

  it("parks the lead in its sequence's subsequence, never deletes it, and answers with what it read back", async () => {
    enrolled();
    const r = await adapter().withdraw(request(), ctx(false));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(state.leads.map((l) => [l.id, l.campaign, l.subsequence_id]), [["lead-1", "c1", "s1"]], "the lead is gone, or not parked");
    assert.deepEqual(
      writes().map((s) => `${s.method} ${s.path}`),
      ["POST /api/v2/leads/subsequence/move"],
      "a withdrawal wrote something else than the move",
    );
    assert.ok(seen.some((s) => s.method === "GET" && s.path === "/api/v2/leads/lead-1"), "the lead was not read back");
    if (r.ok) {
      assert.equal(r.value.found, true);
      assert.deepEqual([r.value.readBack?.subsequence_id, r.value.readBack?.campaign, r.value.readBack?.email], ["s1", "c1", "ada@example.com"]);
    }
  });

  it("says which enrolment it stopped: the key the lead it read back carries (0060)", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1, payload: { engine_idempotency_key: "k1" } });
    const r = await adapter().withdraw(request(), ctx(false));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.equal(r.value.idempotencyKey, "k1");
  });

  it("in dry run, writes nothing and still says which enrolment it would stop", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1, payload: { engine_idempotency_key: "k1" } });
    const r = await adapter().withdraw(request(), ctx(true));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.deepEqual(writes(), []);
    assert.equal(r.value.idempotencyKey, "k1");
  });

  it("stops a lead enrolled outside this engine by address, and says it carries no key", async () => {
    enrolled();
    const r = await adapter().withdraw(request(), ctx(false));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.equal(r.value.found, true);
    assert.equal(state.leads[0]?.subsequence_id, "s1", "the lead was not parked");
    assert.equal(r.value.idempotencyKey, undefined, "a key nobody wrote was reported");
  });

  it("is an error, not a success, when Instantly answers 200 and the lead does not read back as parked", async () => {
    enrolled();
    state.moveDoesNothing = true;
    const r = await adapter().withdraw(request(), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error.code, "unknown");
      assert.match(r.error.message, /does not read back as parked/);
    }
  });

  it("parks an already parked lead once: the replay moves nothing and still reads back", async () => {
    enrolled();
    await adapter().withdraw(request(), ctx(false));
    seen = [];
    const again = await adapter().withdraw(request(), ctx(false));
    assert.equal(again.ok, true);
    assert.deepEqual(writes(), []);
    assert.ok(seen.some((s) => s.method === "GET" && s.path === "/api/v2/leads/lead-1"));
  });

  it("succeeds for someone not enrolled, saying so, and writes nothing", async () => {
    const r = await adapter().withdraw(request(), ctx(false));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.found, false);
    assert.deepEqual(writes(), []);
  });

  it("in dry run, checks the parking subsequence and writes nothing", async () => {
    enrolled();
    const r = await adapter().withdraw(request(), ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.simulated, true);
    assert.ok(seen.some((s) => s.method === "GET" && s.path === "/api/v2/subsequences/s1"));
    assert.deepEqual(writes(), []);
    assert.equal(state.leads[0]?.subsequence_id, undefined);
  });

  it("refuses a parking subsequence of another campaign: this one would keep sending", async () => {
    enrolled();
    const r = await adapter("test-key", { "subsequence.welcome": "s9" }).withdraw(request(), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /belongs to another campaign/);
    assert.deepEqual(writes(), []);
  });

  it("refuses a sequence bound to no parking subsequence, before calling anyone", async () => {
    enrolled();
    const r = await adapter("test-key", {}).withdraw(request(), ctx(false));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error.message, /no parking subsequence is bound for the sequence "welcome"/);
    assert.deepEqual(seen, []);
  });
});

describe("what it declares (decision 0051)", () => {
  it("is a valid declaration, read without calling Instantly: it parks, at the costs seen live, with its gap unknown", () => {
    const a = adapter();
    assert.deepEqual(checkDeclaration(a.declares), []);
    const s = a.declares!.suspend;
    assert.equal(s.serves, "yes");
    if (s.serves === "yes") {
      assert.deepEqual(s.costs, { person: ["provider_status_stays_active"], sequence: ["shared_state_changes"] });
      assert.equal(s.gap.known, false, "a gap nobody measured is declared as a number");
      assert.equal(s.notTheLeastDestructive, undefined);
    }
    assert.deepEqual([a.declares!.pullTouches.serves, a.declares!.pullUnsubscribes.serves], ["no", "no"]);
    assert.equal(readDeclaration(a).suspends, true);
    assert.deepEqual(seen, []);
  });

  it("declares it cannot suspend when a bound sequence has no parking subsequence: kernel-enrol then refuses it", () => {
    const a = adapter("test-key", {});
    assert.equal(a.declares!.suspend.serves, "no");
    const read = readDeclaration(a);
    assert.equal(read.suspends, false);
    assert.match(read.refusal ?? "", /no parking subsequence is bound for "welcome"/);
  });

  it("declares what the send of 2026-10-21 showed, and only that (decision 0065)", () => {
    const d = adapter().declares!;
    assert.deepEqual([d.deliveredForm?.form, d.deliveredForm?.measuredOn], ["plain_text", "2026-10-21"]);
    assert.equal(d.wayOut?.offered, "known_after");
    if (d.wayOut?.offered === "known_after") assert.equal(d.wayOut.window.known, false, "a window nobody measured is declared as a number");
    assert.equal(d.classesStop?.classes, "no", "a stop the provider was never seen to class is declared classed");
    const text = readDeclaration(adapter()).lines.join("\n");
    assert.match(text, /delivers a body as: plain text/);
    assert.match(text, /a way out in the body: Instantly's unsubscribe link, \/unsub\/1\/<lead id>, whose id comes back with the upload, known only after the call/);
  });
});

describe("suppress", () => {
  const request = (target: Identity) => ({ idempotencyKey: "s1", target, reason: "protected" });
  const company = (...keys: Identity["keys"]): Identity => ({ subject: "company", keys });

  it("blocklists a whole domain, in Instantly's format, and says what it applied", async () => {
    const start = Date.now();
    const r = await adapter().suppress(request(company({ kind: "domain", value: "@Example.ORG" })), ctx(false));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(state.blocklist, ["example.org"]);
    if (r.ok) {
      assert.deepEqual(r.value.applied, [{ kind: "domain", value: "@Example.ORG" }]);
      // Every answer carries the time of its read (0051).
      assert.ok(Date.parse(r.value.asOf) >= start, `asOf ${String(r.value.asOf)} is not the time of the read-back`);
    }
    // Read back (0051): the entry is read again after it is written.
    const written = seen.findIndex((s) => s.method === "POST" && s.path === "/api/v2/block-lists-entries");
    assert.ok(
      seen.slice(written + 1).some((s) => s.method === "GET" && s.path === "/api/v2/block-lists-entries?search=example.org&limit=50"),
      "the entry was not read back after it was written",
    );
  });

  it("is an error, not a success, when Instantly answers 200 and the blocklist does not read the entry back", async () => {
    state.blockDoesNothing = true;
    const r = await adapter().suppress(request(ada()), ctx(false));
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) {
      assert.equal(r.error.code, "unknown");
      assert.match(r.error.message, /does not read it back/);
    }
  });

  it("applies what it can and names what it cannot — every channel's key reaches the same person", async () => {
    const target = company({ kind: "domain", value: "example.org" }, { kind: "social_company_id", network: "net_a", value: "c-1" });
    const r = await adapter().suppress(request(target), ctx(false));
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) {
      assert.deepEqual(r.value.applied.map((k) => k.kind), ["domain"]);
      assert.deepEqual(r.value.notApplicable.map((k) => k.kind), ["social_company_id"]);
    }
  });

  it("refuses an identity it cannot act on at all, rather than reporting a suppression that suppressed nothing", async () => {
    const r = await adapter().suppress(
      request({ subject: "person", keys: [{ kind: "social_profile_id", network: "net_a", value: "p-1" }] }),
      ctx(false),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "invalid");
    assert.deepEqual(writes(), []);
  });

  it("writes nothing for a target already blocked, and still reports it applied", async () => {
    state.blocklist.push("ada@example.com");
    const r = await adapter().suppress(request(ada()), ctx(false));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.applied.length, 1);
    assert.deepEqual(writes(), []);
  });

  it("in dry run, writes nothing", async () => {
    const r = await adapter().suppress(request(company({ kind: "domain", value: "example.org" })), ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.simulated, true);
    assert.deepEqual(writes(), []);
    assert.deepEqual(state.blocklist, []);
  });
});

describe("status", () => {
  it("reads an opt-out as unsubscribed, not as stopped", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: -2 });
    const r = await adapter().status({ person: ada(), sequenceKey: "welcome" }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.state, "unsubscribed");
  });

  it("reads a parked lead as stopped, though Instantly reads it as active", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1, subsequence_id: "s1" });
    const r = await adapter().status({ person: ada(), sequenceKey: "welcome" }, ctx(true));
    if (r.ok) assert.equal(r.value.state, "stopped");
    else assert.fail(JSON.stringify(r));
  });

  it("answers with the time of its read, never the lead's own modification time (0051)", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1, timestamp_updated: "2020-01-01T00:00:00.000Z" });
    const before = Date.now();
    const r = await adapter().status({ person: ada(), sequenceKey: "welcome" }, ctx(true));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.notEqual(r.value.asOf, "2020-01-01T00:00:00.000Z");
    assert.ok(Date.parse(r.value.asOf) >= before, `asOf ${r.value.asOf} is older than the read`);
  });

  it("says which enrolment it read: the key the lead carries, the one the engine enrolled it under (0060)", async () => {
    await adapter().enrol(enrolment(), ctx(false));
    const r = await adapter().status({ person: ada(), sequenceKey: "welcome" }, ctx(true));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.equal(r.value.idempotencyKey, "k1");
  });

  it("reports no key for a lead the engine did not enrol, though it finds it by address", async () => {
    state.leads.push({ id: "lead-1", email: "ada@example.com", campaign: "c1", status: 1 });
    const r = await adapter().status({ person: ada(), sequenceKey: "welcome" }, ctx(true));
    if (!r.ok) return assert.fail(JSON.stringify(r));
    assert.equal(r.value.state, "active");
    assert.equal(r.value.idempotencyKey, undefined, "a key nobody wrote was reported");
  });

  it("reads no enrolment as unknown, not as an error", async () => {
    const r = await adapter().status({ person: ada("nobody@example.com"), sequenceKey: "welcome" }, ctx(true));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.state, "unknown");
  });
});

describe("capacity", () => {
  it("is per channel, and refuses one the adapter does not serve", async () => {
    const r = await adapter().capacity({ sender: { externalId: "sender@example.com" }, channel: "social_invite" }, ctx(true));
    assert.equal(r.ok, false);
    assert.equal(seen.length, 0);
  });

  it("is the daily limit less what the account sent today", async () => {
    const r = await adapter().capacity({ sender: { externalId: "sender@example.com" }, channel: "email" }, ctx(true));
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) {
      assert.equal(r.value.channel, "email");
      assert.deepEqual(r.value.limits, [{ unit: "messages", window: "day", limit: 40, used: 15, remaining: 25 }]);
    }
  });

  it("is nothing left for an account that is not active", async () => {
    state.accounts["sender@example.com"] = { daily_limit: 40, status: 2 };
    const r = await adapter().capacity({ sender: { externalId: "sender@example.com" }, channel: "email" }, ctx(true));
    if (r.ok) assert.equal(r.value.limits[0]?.remaining, 0);
  });

  it("maps the workspace rate limit to a retryable error", async () => {
    state.forceStatus = 429;
    const r = await adapter().capacity({ sender: { externalId: "sender@example.com" }, channel: "email" }, ctx(true));
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
 * in depth for protected accounts (0012). Today nothing here can do that:
 * nothing is deleted, the only blocklist write is one entry. This list is
 * what keeps it so. Adding an endpoint is a change to this list, made on
 * purpose and seen in review — never a side effect of a new method.
 */
const ALLOWED = [
  "GET /api/v2/campaigns",
  "GET /api/v2/campaigns/{}",
  "POST /api/v2/leads/list",
  "POST /api/v2/leads/add",
  "POST /api/v2/leads/subsequence/move",
  "GET /api/v2/leads/{}",
  "GET /api/v2/subsequences/{}",
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
});

/**
 * Every request the suite made stayed on the pinned list.
 *
 * A file-level `after`, not a test: a test sees only the requests made before
 * it runs, so as a test this held only while it happened to be last in the
 * file, and nothing kept it last. This runs once the whole file is done,
 * wherever it is written, and a failure here fails the run. It also requires
 * that every pinned endpoint was exercised, so a partial run cannot pass.
 */
after(() => {
  const shape = (path: string) =>
    path.replace(/^\/api\/v2\/(campaigns|leads|accounts|subsequences)\/(?!list$|add$|analytics\/daily$)[^/]+$/, "/api/v2/$1/{}");
  const seen = [...new Set(everyRequest.map((r) => `${r.method} ${shape(r.path)}`))].sort();
  assert.deepEqual(seen.filter((e) => !ALLOWED.includes(e)), [], "a request left the pinned endpoint surface");
  // Equal, not merely inside: a run that exercises only part of the surface
  // — a filtered run, or a suite that lost the tests for an endpoint — has
  // not checked the rest, and must not pass as if it had.
  assert.deepEqual(seen, ALLOWED, "the suite did not exercise every pinned endpoint");
});
