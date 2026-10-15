/**
 * Every `assert.ok` here carries a message. Without one, a failing
 * `assert.ok` under tsx can hang while Node rebuilds the message from the
 * source, and the failure surfaces as a timeout instead of a failure.
 *
 * Tests for the asynchronous enrichment adapter, against a fake of the
 * provider's API in the shapes its reference gives. No real workspace is
 * read and nothing is paid for: what is proven is the contract's shape, that
 * a dry run submits nothing, that a submission is never repeated, and that
 * every failure after one names its job (CLAUDE.md §5: reading a real
 * workspace is integration, done with the owner).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { identityVocabulary } from "@werunfoundry/core/identity";

import { acceptCompletion } from "@werunfoundry/relations/contracts/enrichment";
import factory from "./index.js";

interface Seen {
  method: string;
  path: string;
  body?: { name?: string; data?: { linkedin_url?: string; enrich_fields?: string[] }[] };
  auth?: string;
}

const JOB = "2db5ea61-1752-42cf-8ea1-ab1da060cd0a";

const state = {
  /** What each job read answers, in turn; the last one repeats. */
  reads: [] as { status: number; body: unknown }[],
  postStatus: 200,
  postBody: { enrichment_id: JOB } as unknown,
  verifyStatus: 200,
  hangPost: false,
  hangGet: false,
};
let seen: Seen[] = [];
const everyRequest: { method: string; path: string }[] = [];
const hung: ServerResponse[] = [];
let server: Server;
let baseUrl = "";

const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b));
  });

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fake");
  const text = await read(req);
  const entry: Seen = {
    method: req.method ?? "",
    path: url.pathname,
    ...(text ? { body: JSON.parse(text) as Seen["body"] } : {}),
    ...(req.headers.authorization ? { auth: String(req.headers.authorization) } : {}),
  };
  seen.push(entry);
  // The pinned surface is compared on the route, not on one job's id.
  everyRequest.push({ method: entry.method, path: url.pathname.replace(/\/contact\/enrich\/bulk\/.+$/, "/contact/enrich/bulk/{id}") });
  const reply = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  if (req.method === "GET" && url.pathname === "/account/keys/verify") {
    return state.verifyStatus === 200 ? reply(200, { workspace_id: "w" }) : reply(state.verifyStatus, { code: "error.api.key", message: "Unknown api key" });
  }
  if (req.method === "POST" && url.pathname === "/contact/enrich/bulk") {
    if (state.hangPost) return void hung.push(res);
    return state.postStatus === 200 ? reply(200, state.postBody) : reply(state.postStatus, { code: "error.enrichment.data.empty", message: "Data is empty" });
  }
  if (req.method === "GET" && url.pathname.startsWith("/contact/enrich/bulk/")) {
    if (state.hangGet) return void hung.push(res);
    const next = state.reads.length > 1 ? state.reads.shift()! : state.reads[0];
    if (!next) return reply(404, { code: "error.enrichment.not_found", message: "Enrichment ID not found" });
    return reply(next.status, next.body);
  }
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
  state.reads = [];
  state.postStatus = 200;
  state.postBody = { enrichment_id: JOB };
  state.verifyStatus = 200;
  state.hangPost = false;
  state.hangGet = false;
  seen = [];
});

const RUN = "00000000-0000-4000-8000-000000000000";
const ctx = (dryRun = false, runId = RUN): CallContext => ({ runId, actor: { type: "system" }, dryRun });
const adapter = (options: Record<string, string | number | boolean> = {}, key: string | null = "test-key") =>
  factory({ options: { baseUrl, network: "net_a", pollMs: 20, waitMs: 2_000, ...options }, env: key === null ? {} : { FULLENRICH_API_KEY: key } });
const person: Identity = {
  subject: "person",
  keys: [
    { kind: "social_profile_id", network: "net_a", value: "1234" },
    { kind: "social_profile_handle", network: "net_a", value: "ada-example" },
  ],
};
const posts = () => seen.filter((s) => s.method === "POST");

/** A finished job, in the shape their reference gives. */
const finished = (record: Record<string, unknown>, credits = 1) => ({
  status: 200,
  body: { id: JOB, name: "n", status: "FINISHED", cost: { credits }, data: [record] },
});
const profile = (id?: number) => ({
  profile: { social_profiles: { professional_network: { ...(id !== undefined ? { id } : {}), handle: "ada-example", url: "https://profiles.invalid/in/ada-example" } } },
});

const vocabulary = identityVocabulary(
  [
    {
      name: "relations",
      version: "0",
      description: "x",
      schema: "relations",
      dependsOn: [],
      identityKeys: [
        { kind: "email", subject: "person", immutable: false, caseInsensitive: true },
        { kind: "phone", subject: "person", immutable: false },
        { kind: "social_profile_id", subject: "person", immutable: true, networked: true },
        { kind: "social_profile_handle", subject: "person", immutable: false, networked: true },
      ],
    },
  ],
  ["net_a"],
);

describe("probe", () => {
  it("verifies the key, as a bearer token, on the endpoint that spends nothing", async () => {
    const r = await adapter().probe!(ctx());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([seen[0]?.method, seen[0]?.path, seen[0]?.auth], ["GET", "/account/keys/verify", "Bearer test-key"]);
  });

  it("reports a refused key as unauthorized", async () => {
    state.verifyStatus = 401;
    const r = await adapter().probe!(ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized", JSON.stringify(r));
  });

  it("fails without a key, calling nobody", async () => {
    const r = await adapter({}, null).probe!(ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized", JSON.stringify(r));
    assert.equal(seen.length, 0);
  });
});

describe("complete: what is submitted", () => {
  it("refuses a person without a profile handle, submitting nothing", async () => {
    const r = await adapter().complete({ identity: { subject: "person", keys: [person.keys[0]!] }, want: ["email"] }, ctx());
    assert.ok(!r.ok && r.error.code === "invalid" && /profile handle/.test(r.error.message), JSON.stringify(r));
    assert.equal(seen.length, 0);
  });

  it("refuses to be asked for nothing in particular — everything would include a phone — submitting nothing", async () => {
    for (const want of [undefined, [], ["fax"]]) {
      const r = await adapter().complete({ identity: person, ...(want ? { want } : {}) }, ctx());
      assert.ok(!r.ok && r.error.code === "invalid" && /named kinds only/.test(r.error.message), JSON.stringify(r));
    }
    assert.equal(seen.length, 0);
  });

  it("submits nothing in a dry run, and says the answer is simulated", async () => {
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx(true));
    assert.ok(r.ok && r.simulated === true && r.value.found === false, JSON.stringify(r));
    assert.equal(seen.length, 0, "a dry run reached the provider");
  });

  it("submits one person by profile URL, asking only for work addresses when asked for an address", async () => {
    state.reads = [finished({ ...profile(1234), contact_info: { work_emails: [] } })];
    await adapter().complete({ identity: person, want: ["email"] }, ctx());
    const body = posts()[0]?.body;
    assert.equal(body?.data?.length, 1);
    assert.equal(body?.data?.[0]?.linkedin_url, "https://www.linkedin.com/in/ada-example/");
    assert.deepEqual(body?.data?.[0]?.enrich_fields, ["contact.work_emails"]);
  });

  it("names the job from the run and the subject, the same each time, so a person can find it", async () => {
    state.reads = [finished({ ...profile(1234) })];
    await adapter().complete({ identity: person, want: ["email"] }, ctx());
    await adapter().complete({ identity: person, want: ["email"] }, ctx());
    await adapter().complete({ identity: person, want: ["email"] }, ctx(false, "11111111-1111-4111-8111-111111111111"));
    const names = posts().map((p) => p.body?.name ?? "");
    assert.equal(names[0], names[1]);
    assert.notEqual(names[0], names[2]);
    assert.match(names[0]!, new RegExp(`^kernel ${RUN} [0-9a-f]{12}$`));
  });
});

describe("complete: what is returned", () => {
  it("returns the profile's keys and the addresses the provider stands behind, with what it said, and the cost", async () => {
    state.reads = [
      { status: 400, body: { code: "error.enrichment.in_progress", message: "Enrichment not ready, try again in 30 seconds" } },
      { status: 200, body: { id: JOB, status: "IN_PROGRESS" } },
      finished(
        {
          ...profile(1234),
          contact_info: {
            work_emails: [
              { email: "Ada@Example.com", status: "DELIVERABLE" },
              { email: "ada.e@example.com", status: "CATCH_ALL" },
              { email: "nobody@example.com", status: "INVALID" },
              { email: "ada@example.invalid", status: "INVALID_DOMAIN" },
            ],
            personal_emails: [{ email: "ada@example.org", status: "DELIVERABLE" }],
          },
        },
        2,
      ),
    ];
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (!r.ok || !r.value.found) return;
    assert.deepEqual(r.value.attested.keys.map((k) => `${k.kind}=${k.value}`), [
      "social_profile_id=1234",
      "social_profile_handle=ada-example",
      "email=ada@example.com",
      "email=ada.e@example.com",
    ]);
    assert.deepEqual(r.value.said?.map((s) => `${s.key.value}:${s.status}`), ["ada@example.com:DELIVERABLE", "ada.e@example.com:CATCH_ALL"]);
    assert.deepEqual(r.value.cost, { amount: 2, unit: "credits" });
    assert.equal(posts().length, 1);
    // And the contract takes it: the answer names the immutable id (0022).
    assert.ok("accepted" in acceptCompletion(person, r.value, vocabulary), "the contract rejected a completion that names the profile id");
  });

  it("returns an answer without the profile's id as the provider gave it, and the contract rejects it (0022)", async () => {
    state.reads = [finished({ ...profile(undefined), contact_info: { work_emails: [{ email: "x@example.com", status: "DELIVERABLE" }] } })];
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(r.ok && r.value.found, JSON.stringify(r));
    if (!r.ok) return;
    assert.ok("rejected" in acceptCompletion(person, r.value, vocabulary), "a completion tied by a handle alone was accepted");
  });

  it("is not found when the job finished with nothing about the person", async () => {
    state.reads = [finished({ contact_info: { work_emails: [{ email: "nobody@example.com", status: "INVALID" }] } }, 0)];
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(r.ok && !r.value.found, JSON.stringify(r));
  });

  it("returns numbers only when asked, leaving out the ones the provider disowns", async () => {
    const phones = [
      { number: "+1 555 0100", line_type: "MOBILE", line_status: "ACTIVE" },
      { number: "+1 555 0101", line_type: "MOBILE", line_status: "INACTIVE" },
      { number: "+1 555 0102", line_type: "MOBILE", line_status: "ACTIVE", ownership_match: "MISMATCH" },
    ];
    state.reads = [finished({ ...profile(1234), contact_info: { phones } })];
    const notAsked = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(notAsked.ok && notAsked.value.found && !notAsked.value.attested.keys.some((k) => k.kind === "phone"), JSON.stringify(notAsked));
    const asked = await adapter().complete({ identity: person, want: ["phone"] }, ctx());
    assert.ok(asked.ok && asked.value.found, JSON.stringify(asked));
    if (!asked.ok || !asked.value.found) return;
    assert.deepEqual(asked.value.attested.keys.filter((k) => k.kind === "phone").map((k) => k.value), ["+1 555 0100"]);
    assert.deepEqual(asked.value.said, [{ key: { kind: "phone", value: "+1 555 0100" }, status: "MOBILE/ACTIVE" }]);
    assert.deepEqual(posts()[1]?.body?.data?.[0]?.enrich_fields, ["contact.phones"]);
  });
});

describe("complete: a submission is never repeated, and its failures name it", () => {
  it("a job that never finishes: could not tell, the job's id and name in the error, not retryable, one submission", async () => {
    state.reads = [{ status: 200, body: { id: JOB, status: "IN_PROGRESS" } }];
    const r = await adapter({ waitMs: 200, pollMs: 20 }).complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok, JSON.stringify(r));
    if (r.ok) return;
    assert.equal(r.error.code, "unavailable");
    assert.equal(r.error.retryable, false);
    assert.match(r.error.message, /could not tell: the job was still running after 200 ms/);
    assert.ok(r.error.message.includes(JOB), `the job's id is not in the error: ${r.error.message}`);
    assert.ok(r.error.message.includes(posts()[0]?.body?.name ?? "<no name>"), `the job's name is not in the error: ${r.error.message}`);
    assert.equal(posts().length, 1, "a submission was repeated");
    assert.ok(seen.filter((s) => s.method === "GET").length > 1, "the job was not waited for");
  });

  it("a job read that never answers: the job's id in the error, not retryable", async () => {
    state.hangGet = true;
    const r = await adapter({ timeoutMs: 100 }).complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok && r.error.retryable === false && r.error.message.includes(JOB), JSON.stringify(r));
    assert.equal(posts().length, 1);
  });

  it("a submission that never answers: the job may exist, so its name is in the error, and it is not retryable", async () => {
    state.hangPost = true;
    const r = await adapter({ timeoutMs: 100 }).complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok, JSON.stringify(r));
    if (r.ok) return;
    assert.equal(r.error.retryable, false);
    assert.match(r.error.message, /may have been accepted without its id coming back; look for the job named "kernel [^"]+" by hand/);
    assert.equal(posts().length, 1);
  });

  it("a submission accepted without an id: not retryable, named", async () => {
    state.postBody = {};
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok && r.error.retryable === false && /accepted without a job id; look for the job named/.test(r.error.message), JSON.stringify(r));
  });

  it("credits running out during the job: unauthorized, named", async () => {
    state.reads = [{ status: 402, body: { id: JOB, status: "CREDITS_INSUFFICIENT", data: [] } }];
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized" && r.error.retryable === false && r.error.message.includes(JOB), JSON.stringify(r));
  });

  it("a job that ends cancelled, or with more records than people: an error, never an empty answer", async () => {
    state.reads = [{ status: 200, body: { id: JOB, status: "CANCELED" } }];
    const cancelled = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!cancelled.ok && cancelled.error.message.includes(JOB), JSON.stringify(cancelled));
    state.reads = [{ status: 200, body: { id: JOB, status: "FINISHED", data: [] } }];
    const empty = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!empty.ok && /finished with 0 records/.test(empty.error.message), JSON.stringify(empty));
  });

  it("a refused submission is the request's error: no job, so nothing to name", async () => {
    state.postStatus = 400;
    const r = await adapter().complete({ identity: person, want: ["email"] }, ctx());
    assert.ok(!r.ok && r.error.code === "invalid" && !r.error.message.includes("job"), JSON.stringify(r));
  });
});

/* -------------------------------------------------------------------------- */
/* The endpoint surface, pinned                                                */
/* -------------------------------------------------------------------------- */

const ALLOWED = ["GET /account/keys/verify", "GET /contact/enrich/bulk/{id}", "POST /contact/enrich/bulk"].sort();

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("the endpoint surface", () => {
  it("is exactly the pinned list, read from the source", () => {
    const sites = [...source.matchAll(/\bcall<[\s\S]*?>\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)].map(([, method, path]) => {
      const bare = path!.slice(1, -1).replace(/\$\{[^}]*\}/g, "{id}").split("?")[0];
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
