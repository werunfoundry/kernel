/**
 * Tests for the sequencer's mailbox as an inbound source (decision 0071),
 * against a fake of the API's received mail: what it reads, what it says
 * of who wrote a reply, how its cursor moves. The same adapter through its
 * published name, the kernel's own pull and a database is `try-instance`'s
 * step "the sequencer's mailbox": an adapter's test reaches neither.
 */

import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Inbound } from "@werunfoundry/acquisition/contracts/inbound";

import factory from "./index.js";

interface Mail {
  id: string;
  lead?: string | null;
  campaign_id?: string | null;
  ue_type?: number | null;
  is_auto_reply?: number | null;
  from_address_json?: unknown[] | null;
  timestamp_email?: string | null;
  timestamp_created: string;
}

/** The fake's received mail, and every request it was asked. */
let mail: Mail[] = [];
let asked: URL[] = [];
let forceStatus = 0;
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    asked.push(url);
    const reply = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (forceStatus) return reply(forceStatus, { message: "forced" });
    if (req.method !== "GET" || url.pathname !== "/api/v2/emails") return reply(404, { message: `fake has no ${req.method} ${url.pathname}` });
    const q = url.searchParams;
    const since = q.get("min_timestamp_created");
    // Oldest first by recording time, after the id given: what `sort_order=asc` and `starting_after` are documented to do.
    const all = mail
      .filter((m) => q.get("email_type") !== "received" || m.ue_type !== 1)
      .filter((m) => !since || m.timestamp_created >= since)
      .sort((a, b) => a.timestamp_created.localeCompare(b.timestamp_created));
    const afterId = q.get("starting_after");
    const from = afterId ? all.findIndex((m) => m.id === afterId) + 1 : 0;
    const items = all.slice(from, from + Number(q.get("limit") ?? 100));
    return reply(200, { items, next_starting_after: from + items.length < all.length ? items.at(-1)!.id : null });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  mail = [];
  asked = [];
  forceStatus = 0;
});

const ctx: CallContext = { runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" }, dryRun: false };
const source = (options: Record<string, unknown> = {}) =>
  factory({ options: { baseUrl, "campaign.welcome": "c1", ...options }, env: { INSTANTLY_API_KEY: "test-key" } }) as Inbound;

/** A reply from the lead, in the bound campaign, marked not automatic: the person's own. */
const theirs = (id: string, at: string, over: Partial<Mail> = {}): Mail => ({
  id,
  lead: "ada@example.com",
  campaign_id: "c1",
  ue_type: 2,
  is_auto_reply: 0,
  from_address_json: [{ address: "Ada@Example.com", name: "Ada" }],
  timestamp_email: at,
  timestamp_created: at,
  ...over,
});

describe("the sequencer's mailbox, read as inbound (0071)", () => {
  it("reads a reply from the lead, marked not automatic, as the person's own act, and asks for no body", async () => {
    mail = [theirs("r1", "2026-10-26T09:00:00.000Z")];
    const page = await source().events({}, ctx);
    assert.ok(page.ok, JSON.stringify(page));
    assert.deepEqual(page.value.items, [
      {
        providerEventId: "r1",
        type: "acquisition.reply",
        occurredAt: "2026-10-26T09:00:00.000Z",
        subject: { subject: "person", keys: [{ kind: "email", value: "ada@example.com" }] },
        attribution: { sequenceKey: "welcome", channel: "email" },
        byThePerson: true,
        detail: { automatic: false, fromTheLead: true },
      },
    ]);
    const q = asked[0]!.searchParams;
    assert.deepEqual([q.get("email_type"), q.get("sort_order"), q.get("preview_only")], ["received", "asc", "true"]);
  });

  it("does not say the person wrote it when the reply is automatic, unmarked, from someone else, or by an author it cannot read", async () => {
    mail = [
      theirs("auto", "2026-10-26T09:00:00.000Z", { is_auto_reply: 1 }),
      theirs("unmarked", "2026-10-26T09:01:00.000Z", { is_auto_reply: null }),
      theirs("colleague", "2026-10-26T09:02:00.000Z", { from_address_json: [{ address: "bo@example.com" }] }),
      theirs("unreadable", "2026-10-26T09:03:00.000Z", { from_address_json: ["ada@example.com"] }),
      theirs("nobody", "2026-10-26T09:04:00.000Z", { from_address_json: null }),
    ];
    const page = await source().events({}, ctx);
    assert.ok(page.ok);
    assert.deepEqual(
      page.value.items.map((e) => [e.providerEventId, e.byThePerson, e.detail]),
      [
        ["auto", false, { automatic: true, fromTheLead: true }],
        ["unmarked", false, { automatic: null, fromTheLead: true }],
        ["colleague", false, { automatic: false, fromTheLead: false }],
        ["unreadable", false, { automatic: false, fromTheLead: null }],
        ["nobody", false, { automatic: false, fromTheLead: null }],
      ],
    );
    // Each is still the lead's reply: the provider's attribution.
    assert.ok(page.value.items.every((e) => e.subject.keys[0]!.value === "ada@example.com"));
  });

  it("passes over a reply of an unbound campaign, of none, one typed other than received, and one with no lead", async () => {
    mail = [
      theirs("other", "2026-10-26T09:00:00.000Z", { campaign_id: "c9" }),
      theirs("manual", "2026-10-26T09:01:00.000Z", { campaign_id: null }),
      theirs("scheduled", "2026-10-26T09:02:00.000Z", { ue_type: 4 }),
      theirs("leadless", "2026-10-26T09:03:00.000Z", { lead: null }),
      theirs("kept", "2026-10-26T09:04:00.000Z"),
    ];
    const page = await source().events({}, ctx);
    assert.ok(page.ok);
    assert.deepEqual(page.value.items.map((e) => e.providerEventId), ["kept"]);
  });

  it("pages after its cursor, then starts the next read an overlap before the latest it saw, and settles there", async () => {
    mail = [theirs("r1", "2026-10-26T09:00:00.000Z"), theirs("r2", "2026-10-26T09:30:00.000Z"), theirs("r3", "2026-10-26T10:00:00.000Z")];
    const inbound = source({ repliesOverlapMinutes: 60 });
    const first = await inbound.events({ limit: 2 }, ctx);
    assert.ok(first.ok);
    assert.deepEqual(first.value.items.map((e) => e.providerEventId), ["r1", "r2"]);
    const second = await inbound.events({ after: first.value.cursor, limit: 2 }, ctx);
    assert.ok(second.ok);
    assert.deepEqual(second.value.items.map((e) => e.providerEventId), ["r3"]);
    assert.equal(asked.at(-1)!.searchParams.get("starting_after"), "r2");
    // The read reached its end: the next starts an hour before 10:00, and reads all three again.
    const third = await inbound.events({ after: second.value.cursor, limit: 10 }, ctx);
    assert.ok(third.ok);
    assert.equal(asked.at(-1)!.searchParams.get("min_timestamp_created"), "2026-10-26T09:00:00.000Z");
    assert.deepEqual(third.value.items.map((e) => e.providerEventId), ["r1", "r2", "r3"]);
    assert.equal(third.value.cursor, second.value.cursor, "a read with nothing new does not move the cursor");
  });

  it("returns an empty page, its cursor moved, after reading its scan bound with no reply of a bound campaign", async () => {
    mail = [1, 2, 3, 4, 5].map((n) => theirs(`x${n}`, `2026-10-26T09:0${n}:00.000Z`, { campaign_id: "c9" })).concat(theirs("r1", "2026-10-26T09:09:00.000Z"));
    const inbound = source({ scanPages: 2 });
    const first = await inbound.events({ limit: 2 }, ctx);
    assert.ok(first.ok);
    assert.deepEqual([first.value.items.length, asked.length], [0, 2]);
    const second = await inbound.events({ after: first.value.cursor, limit: 2 }, ctx);
    assert.ok(second.ok);
    assert.deepEqual(second.value.items.map((e) => e.providerEventId), ["r1"]);
  });

  it("answers an error, never an empty page, when it cannot read, and refuses a cursor it did not make or no campaign bound", async () => {
    forceStatus = 401;
    const refused = await source().events({}, ctx);
    assert.ok(!refused.ok && refused.error.code === "unauthorized");
    forceStatus = 0;
    const foreign = await source().events({ after: "not-ours" }, ctx);
    assert.ok(!foreign.ok && foreign.error.code === "invalid");
    const unbound = await (factory({ options: { baseUrl }, env: { INSTANTLY_API_KEY: "test-key" } }) as Inbound).events({}, ctx);
    assert.ok(!unbound.ok && /no campaign is bound/.test(unbound.error.message));
  });
});
