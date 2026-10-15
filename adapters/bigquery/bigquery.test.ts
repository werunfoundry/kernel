/**
 * Tests for the warehouse target list, against a fake of BigQuery's REST API
 * and of the token endpoint.
 *
 * The fake answers in the shapes the published reference gives — a job per
 * query, pages by token, every value a string — and holds invented rows. It
 * verifies the signed assertion with the public half of a key made for this
 * run, so the service-account path is exercised for real, not injected.
 * Reading a real warehouse is integration, done with the owner (CLAUDE.md §5).
 */

import { strict as assert } from "node:assert";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { TargetList } from "@werunfoundry/gtm/contracts/target-list";

import factory, { candidatesSql, freshnessSql, protectedSql } from "./index.js";

/* -------------------------------------------------------------------------- */
/* The fake                                                                    */
/* -------------------------------------------------------------------------- */

type Data = Record<string, string | null>;

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  bearer?: string;
}

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const state = {
  targets: [] as Data[],
  customers: [] as Data[],
  /** Extraction times, by table, as the fake's MIN/MAX see them. */
  extracted: { targets: [] as (string | null)[], customers: [] as (string | null)[] },
  /** How many answers say "not complete yet" before one says it is. */
  incomplete: 0,
  /** Rows the result announces beyond those it holds. */
  shortBy: 0,
  forceStatus: 0,
  forceReason: "",
  hang: false,
  tokenRefused: false,
  grants: 0,
  /** A complete answer that carries no schema — a job that failed, said in a 200. */
  noSchema: false,
  /** A page that is empty and still says another follows. */
  emptyPage: false,
};
let seen: Seen[] = [];
const everyRequest: Seen[] = [];
const hung: ServerResponse[] = [];
const jobs = new Map<string, { fields: string[]; rows: (string | null)[][] }>();
let server: Server;
let baseUrl = "";
let tokenUri = "";

const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => done(b));
  });

/** What the fake's "engine" computes for a query: the columns its aliases name, over the table its FROM names. */
function execute(sql: string, params: Record<string, string | string[]>): { fields: string[]; rows: (string | null)[][] } {
  const from = /FROM `[^`]+`\.`[^`]+`\.`([^`]+)`/.exec(sql)?.[1];
  const table = from === "targets" ? state.targets : from === "customers" ? state.customers : undefined;
  if (!table) throw Object.assign(new Error(`Not found: Table ${from}`), { status: 404, reason: "notFound" });
  if (sql.includes("FORMAT_TIMESTAMP")) {
    const times = state.extracted[from as "targets" | "customers"];
    const dated = times.filter((t): t is string => t !== null).sort();
    const pick = sql.includes("MIN(") ? dated[0] : dated[dated.length - 1];
    return {
      fields: ["as_of", "undated", "row_count"],
      rows: [[pick ?? null, String(times.length - dated.length), String(times.length)]],
    };
  }
  const aliases = [...sql.matchAll(/CAST\(`([^`]+)` AS STRING\) AS (\w+)/g)].map(([, column, alias]) => ({ column: column!, alias: alias! }));
  const filter = /WHERE CAST\(`([^`]+)` AS STRING\) (= @status|IN UNNEST\(@active\))/.exec(sql);
  const kept = table.filter((row) => {
    if (!filter) return true;
    const value = row[filter[1]!] ?? null;
    return filter[2] === "= @status" ? value === params.status : (params.active as string[]).includes(value ?? "");
  });
  return { fields: aliases.map((a) => a.alias), rows: kept.map((row) => aliases.map((a) => row[a.column] ?? null)) };
}

function pageOf(job: string, offset: number, max: number) {
  const result = jobs.get(job)!;
  const rows = result.rows.slice(offset, offset + max);
  const end = offset + rows.length;
  return {
    jobComplete: true,
    jobReference: { projectId: "proj-fixture", jobId: job, location: "EU" },
    schema: { fields: result.fields.map((name) => ({ name, type: "STRING" })) },
    totalRows: String(result.rows.length + state.shortBy),
    ...(rows.length > 0 && !state.emptyPage ? { rows: rows.map((r) => ({ f: r.map((v) => ({ v })) })) } : {}),
    ...(end < result.rows.length || state.emptyPage ? { pageToken: `p${end}` } : {}),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fake");
  const text = await read(req);
  const entry: Seen = { method: req.method ?? "", path: url.pathname + url.search };
  if (req.headers.authorization) entry.bearer = String(req.headers.authorization).replace(/^Bearer /, "");
  if (text && req.headers["content-type"] === "application/json") entry.body = JSON.parse(text) as Record<string, unknown>;
  seen.push(entry);
  everyRequest.push({ method: entry.method, path: url.pathname });
  const reply = (status: number, value: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  const error = (status: number, reason: string, message: string) =>
    reply(status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } });

  if (req.method === "POST" && url.pathname === "/token") {
    const form = new URLSearchParams(text);
    const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
    const verified = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(keys.publicKey, Buffer.from(signature ?? "", "base64url"));
    const c = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as Record<string, unknown>;
    const right =
      verified &&
      form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
      c.scope === "https://www.googleapis.com/auth/bigquery.readonly" &&
      c.aud === tokenUri &&
      c.iss === "reader@example.invalid";
    if (!right || state.tokenRefused) return reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    state.grants++;
    return reply(200, { access_token: "granted-token", expires_in: 3600, token_type: "Bearer" });
  }

  if (state.hang) {
    hung.push(res);
    return;
  }
  if (entry.bearer !== "granted-token" && entry.bearer !== "static-token") return error(401, "unauthorized", "Request had invalid authentication credentials.");
  if (state.forceStatus) return error(state.forceStatus, state.forceReason, `forced ${state.forceStatus}`);

  const posted = /^\/projects\/([^/]+)\/queries$/.exec(url.pathname);
  if (req.method === "POST" && posted) {
    const body = entry.body as { query: string; queryParameters?: { name: string; parameterValue: { value?: string; arrayValues?: { value: string }[] } }[]; maxResults?: number; dryRun?: boolean };
    const params = Object.fromEntries(
      (body.queryParameters ?? []).map((p) => [p.name, p.parameterValue.arrayValues ? p.parameterValue.arrayValues.map((v) => v.value) : p.parameterValue.value ?? ""]),
    );
    let result;
    try {
      result = execute(body.query, params);
    } catch (thrown) {
      const t = thrown as { status: number; reason: string; message: string };
      return error(t.status, t.reason, t.message);
    }
    if (body.dryRun) return reply(200, { jobComplete: true, totalBytesProcessed: "0", schema: { fields: [] } });
    const job = `job-${jobs.size + 1}`;
    jobs.set(job, result);
    if (state.incomplete > 0) {
      state.incomplete--;
      return reply(200, { jobComplete: false, jobReference: { projectId: "proj-fixture", jobId: job, location: "EU" } });
    }
    if (state.noSchema) return reply(200, { jobComplete: true, jobReference: { jobId: job }, errors: [{ reason: "invalidQuery", message: "it failed" }] });
    return reply(200, pageOf(job, 0, body.maxResults ?? 1000));
  }

  const got = /^\/projects\/([^/]+)\/queries\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && got) {
    const job = decodeURIComponent(got[2]!);
    if (!jobs.has(job)) return error(404, "notFound", `Not found: Job ${job}`);
    if (state.incomplete > 0) {
      state.incomplete--;
      return reply(200, { jobComplete: false, jobReference: { projectId: "proj-fixture", jobId: job, location: "EU" } });
    }
    const token = url.searchParams.get("pageToken");
    return reply(200, pageOf(job, token ? Number(token.slice(1)) : 0, Number(url.searchParams.get("maxResults") ?? 1000)));
  }
  return reply(404, { error: { code: 404, message: `fake has no ${req.method} ${url.pathname}` } });
}

before(async () => {
  server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: 500, message: `fake failed: ${(error as Error).message}` } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokenUri = `${baseUrl}/token`;
});

beforeEach(() => {
  for (const res of hung.splice(0)) res.destroy();
  state.targets = [
    { st: "open", dom: "alpha.example.com", cid: "1001", tid: "t-1", nm: "Alpha" },
    { st: "open", dom: "beta.example.com", cid: null, tid: "t-2", nm: "Beta" },
    { st: "open", dom: null, cid: null, tid: "t-3", nm: "Nameless" },
    { st: "won", dom: "gamma.example.com", cid: "1003", tid: "t-4", nm: "Gamma" },
  ];
  state.customers = [
    { sub: "active", dom: "client.example.org", cust: "c-1", nm: "Client" },
    { sub: "trialing", dom: "trial.example.org", cust: "c-2", nm: "Trial" },
    { sub: "cancelled", dom: "gone.example.org", cust: "c-3", nm: "Gone" },
  ];
  state.extracted = {
    targets: ["2026-10-14T06:00:00.000Z", "2026-10-14T06:00:00.000Z"],
    customers: ["2026-10-14T05:00:00.000Z", "2026-10-14T07:00:00.000Z"],
  };
  state.incomplete = 0;
  state.shortBy = 0;
  state.forceStatus = 0;
  state.forceReason = "";
  state.hang = false;
  state.tokenRefused = false;
  state.grants = 0;
  state.noSchema = false;
  state.emptyPage = false;
  seen = [];
});

after(() => {
  for (const res of hung.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
});

const ctx = (): CallContext => ({ runId: "00000000-0000-4000-8000-000000000000", actor: { type: "system" }, dryRun: true });

const OPTIONS = {
  project: "proj-fixture",
  dataset: "warehouse",
  network: "net_a",
  "candidates.table": "targets",
  "candidates.statusColumn": "st",
  "candidates.status": "open",
  "candidates.domainColumn": "dom",
  "candidates.companyIdColumn": "cid",
  "candidates.idColumn": "tid",
  "candidates.nameColumn": "nm",
  "candidates.extractedAtColumn": "extracted_at",
  "protected.table": "customers",
  "protected.activeColumn": "sub",
  "protected.activeValues": "active,trialing",
  "protected.domainColumn": "dom",
  "protected.idColumn": "cust",
  "protected.nameColumn": "nm",
  "protected.extractedAtColumn": "extracted_at",
};

type Options = Record<string, string | number | boolean | undefined>;
const serviceAccount = () => JSON.stringify({ type: "service_account", client_email: "reader@example.invalid", private_key: privatePem, token_uri: tokenUri });

function adapter(options: Options = {}, env: Record<string, string> = { BIGQUERY_ACCESS_TOKEN: "static-token" }): TargetList {
  const merged = Object.fromEntries(Object.entries({ baseUrl, timeoutMs: 2_000, ...OPTIONS, ...options }).filter(([, v]) => v !== undefined));
  return factory({ options: merged as Record<string, string | number | boolean>, env });
}

const posted = () => seen.filter((s) => s.method === "POST" && s.path.endsWith("/queries")).map((s) => s.body as Record<string, unknown>);

/* -------------------------------------------------------------------------- */

describe("the binding", () => {
  it("refuses every call, sending nothing, when options are missing — and names them all", async () => {
    const t = adapter({ "candidates.table": undefined, "protected.activeColumn": undefined });
    for (const r of [await t.freshness("protected", ctx()), await t.candidates({}, ctx()), await t.protectedAccounts({}, ctx()), await t.probe!(ctx())]) {
      assert.ok(!r.ok && r.error.code === "invalid", JSON.stringify(r));
      assert.match(r.error.message, /candidates\.table is required/);
      assert.match(r.error.message, /protected\.activeColumn is required/);
    }
    assert.equal(seen.length, 0);
  });

  it("refuses a name that is not an identifier, so nothing written in an option reaches SQL as code", async () => {
    for (const bad of [{ "candidates.domainColumn": "dom` OR 1=1 --" }, { "protected.table": "customers; DROP TABLE x" }, { project: "Proj With Spaces" }, { dataset: "a.b" }]) {
      const r = await adapter(bad).candidates({}, ctx());
      assert.ok(!r.ok && r.error.code === "invalid" && /is not a/.test(r.error.message), JSON.stringify(r));
    }
    assert.equal(seen.length, 0);
  });

  it("refuses a company id column with no network, an unknown reason, a bad freshness mode, a bad byte cap", async () => {
    for (const [bad, why] of [
      [{ network: undefined }, /needs network/],
      [{ "protected.reason": "vip" }, /protected\.reason is one of/],
      [{ "protected.freshness": "average" }, /"oldest" or "newest"/],
      [{ maximumBytesBilled: "lots" }, /positive whole number/],
      [{ "protected.allowEmpty": "yes" }, /true or false/],
    ] as const) {
      const r = await adapter(bad).freshness("candidates", ctx());
      assert.ok(!r.ok && r.error.code === "invalid" && why.test(r.error.message), JSON.stringify(r));
    }
    assert.equal(seen.length, 0);
  });

  it("takes a table as table, dataset.table or project.dataset.table", async () => {
    await adapter({ "candidates.table": "other_set.targets" }).freshness("candidates", ctx());
    await adapter({ "candidates.table": "proj-other.other_set.targets" }).freshness("candidates", ctx());
    await adapter({ dataset: undefined, "candidates.table": "targets" }).freshness("candidates", ctx()).then((r) => {
      assert.ok(!r.ok && /names no dataset/.test(r.error.message), JSON.stringify(r));
    });
    assert.deepEqual(
      posted().map((b) => /FROM (\S+)/.exec(String(b.query))?.[1]),
      ["`proj-fixture`.`other_set`.`targets`", "`proj-other`.`other_set`.`targets`"],
    );
  });

  it("reads a status or active value written in YAML as a number or a boolean as text", async () => {
    state.targets = [{ st: "1", dom: "one.example.com", cid: null, tid: null, nm: null }];
    state.customers = [{ sub: "true", dom: "on.example.org", cust: null, nm: null }];
    const t = adapter({ "candidates.status": 1, "protected.activeValues": true });
    const c = await t.candidates({}, ctx());
    const p = await t.protectedAccounts({}, ctx());
    assert.ok(c.ok && c.value.items.length === 1 && p.ok && p.value.items.length === 1, JSON.stringify([c, p]));
  });
});

describe("credentials", () => {
  it("sends nothing without credentials", async () => {
    const r = await adapter({}, {}).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized", JSON.stringify(r));
    assert.equal(seen.length, 0);
  });

  it("refuses both forms at once rather than choosing one", async () => {
    const r = await adapter({}, { BIGQUERY_ACCESS_TOKEN: "static-token", BIGQUERY_SERVICE_ACCOUNT: serviceAccount() }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "invalid" && /not both/.test(r.error.message), JSON.stringify(r));
    assert.equal(seen.length, 0);
  });

  it("exchanges a signed assertion for a read-only token once, and reuses it", async () => {
    const t = adapter({}, { BIGQUERY_SERVICE_ACCOUNT: serviceAccount() });
    assert.equal((await t.freshness("protected", ctx())).ok, true);
    assert.equal((await t.freshness("candidates", ctx())).ok, true);
    assert.equal(state.grants, 1);
    assert.deepEqual(seen.filter((s) => s.path.endsWith("/queries")).map((s) => s.bearer), ["granted-token", "granted-token"]);
  });

  it("calls a refused key unauthorized, not an invalid query", async () => {
    state.tokenRefused = true;
    const r = await adapter({}, { BIGQUERY_SERVICE_ACCOUNT: serviceAccount() }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unauthorized" && /the key was refused/.test(r.error.message), JSON.stringify(r));
  });

  it("refuses a key that is not JSON, or cannot sign, without calling anyone", async () => {
    for (const key of ["not json", JSON.stringify({ client_email: "reader@example.invalid", private_key: "not a key", token_uri: tokenUri })]) {
      const r = await adapter({}, { BIGQUERY_SERVICE_ACCOUNT: key }).freshness("protected", ctx());
      assert.ok(!r.ok && r.error.code === "unauthorized", JSON.stringify(r));
    }
    assert.equal(seen.length, 0);
  });
});

describe("freshness", () => {
  it("is the oldest extraction of the route's own table, read from one column", async () => {
    const r = await adapter().freshness("protected", ctx());
    assert.deepEqual(r, { ok: true, value: { route: "protected", asOf: "2026-10-14T05:00:00.000Z" } });
    const sql = String(posted()[0]?.query);
    assert.match(sql, /MIN\(CAST\(`extracted_at` AS TIMESTAMP\)\)/);
    assert.match(sql, /FROM `proj-fixture`\.`warehouse`\.`customers`$/);
    assert.equal(sql.includes("WHERE"), false, "a filter would read another column");
  });

  it("is the newest when the binding says the table is loaded incrementally", async () => {
    const r = await adapter({ "protected.freshness": "newest" }).freshness("protected", ctx());
    assert.ok(r.ok && r.value.asOf === "2026-10-14T07:00:00.000Z", JSON.stringify(r));
    assert.match(String(posted()[0]?.query), /MAX\(/);
  });

  it("is unknown when a row says nothing of when it was extracted", async () => {
    state.extracted.customers.push(null);
    const r = await adapter().freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /1 rows .* no extraction time/.test(r.error.message), JSON.stringify(r));
  });

  it("is unknown for an empty table", async () => {
    state.extracted.customers = [];
    const r = await adapter({ "protected.freshness": "newest" }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /empty/.test(r.error.message), JSON.stringify(r));
  });

  it("is unknown when the newest extraction is null everywhere", async () => {
    state.extracted.customers = [null];
    const r = await adapter({ "protected.freshness": "newest" }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /no extraction time that is a time/.test(r.error.message), JSON.stringify(r));
  });
});

describe("candidates", () => {
  it("filters on the status by parameter, never by text in the query", async () => {
    await adapter({ "candidates.status": "it's open" }).candidates({}, ctx());
    const body = posted()[0]!;
    assert.equal(String(body.query).includes("it's open"), false);
    assert.deepEqual(body.queryParameters, [{ name: "status", parameterType: { type: "STRING" }, parameterValue: { value: "it's open" } }]);
    assert.equal(body.useLegacySql, false);
    assert.equal(body.parameterMode, "NAMED");
  });

  it("returns the domain and the company's id as its keys, and nothing it does not hold", async () => {
    const r = await adapter().candidates({}, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.value.items, [
      {
        externalId: "t-1",
        name: "Alpha",
        domain: "alpha.example.com",
        identity: { subject: "company", keys: [{ kind: "domain", value: "alpha.example.com" }, { kind: "social_company_id", value: "1001", network: "net_a" }] },
        attributes: {},
      },
      { externalId: "t-2", name: "Beta", domain: "beta.example.com", identity: { subject: "company", keys: [{ kind: "domain", value: "beta.example.com" }] }, attributes: {} },
      { externalId: "t-3", name: "Nameless", attributes: {} },
    ]);
    assert.equal(r.value.nextCursor, undefined);
  });

  it("takes the status from the query when one is passed, and refuses any other param", async () => {
    const won = await adapter().candidates({ params: { status: "won" } }, ctx());
    assert.ok(won.ok && won.value.items.map((c) => c.domain).join() === "gamma.example.com", JSON.stringify(won));
    const other = await adapter().candidates({ params: { region: "north" } }, ctx());
    assert.ok(!other.ok && other.error.code === "invalid" && /only a "status" param/.test(other.error.message), JSON.stringify(other));
  });

  it("refuses to read without a status rather than reading every row", async () => {
    const r = await adapter({ "candidates.status": undefined }).candidates({}, ctx());
    assert.ok(!r.ok && r.error.code === "invalid" && /no status/.test(r.error.message), JSON.stringify(r));
    assert.equal(seen.length, 0);
  });

  it("selects no company id column when the binding names none", async () => {
    const r = await adapter({ "candidates.companyIdColumn": undefined, network: undefined }).candidates({}, ctx());
    assert.ok(r.ok && r.value.items[0]?.identity?.keys.length === 1, JSON.stringify(r));
    assert.equal(String(posted()[0]?.query).includes("company_id"), false);
  });

  it("pages through the one job, and refuses a cursor from the other route or one it did not make", async () => {
    const t = adapter();
    const first = await t.candidates({ limit: 2 }, ctx());
    assert.ok(first.ok && first.value.items.length === 2 && first.value.nextCursor, JSON.stringify(first));
    const second = await t.candidates({ limit: 2, cursor: first.value.nextCursor }, ctx());
    assert.ok(second.ok && second.value.items.length === 1 && second.value.nextCursor === undefined, JSON.stringify(second));
    assert.equal(posted().length, 1, "the second page re-ran the query");
    assert.match(seen[1]!.path, /^\/projects\/proj-fixture\/queries\/job-\d+\?pageToken=p2&/);
    assert.match(seen[1]!.path, /location=EU/);

    const crossed = await t.protectedAccounts({ cursor: first.value.nextCursor }, ctx());
    assert.ok(!crossed.ok && crossed.error.code === "invalid", JSON.stringify(crossed));
    const forged = await t.candidates({ cursor: "not-a-cursor" }, ctx());
    assert.ok(!forged.ok && forged.error.code === "invalid", JSON.stringify(forged));
  });
});

describe("protectedAccounts", () => {
  it("reads the customer table on its active values — not a status on the target table", async () => {
    const r = await adapter().protectedAccounts({}, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.value.items, [
      { externalId: "c-1", name: "Client", domain: "client.example.org", reason: "customer" },
      { externalId: "c-2", name: "Trial", domain: "trial.example.org", reason: "customer" },
    ]);
    const body = posted()[0]!;
    assert.match(String(body.query), /FROM `proj-fixture`\.`warehouse`\.`customers` WHERE CAST\(`sub` AS STRING\) IN UNNEST\(@active\)$/);
    assert.deepEqual(body.queryParameters, [
      { name: "active", parameterType: { type: "ARRAY", arrayType: { type: "STRING" } }, parameterValue: { arrayValues: [{ value: "active" }, { value: "trialing" }] } },
    ]);
  });

  it("refuses an empty set by default: a misspelt active value looks exactly like it", async () => {
    const r = await adapter({ "protected.activeValues": "actve" }).protectedAccounts({}, ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /no account is protected/.test(r.error.message), JSON.stringify(r));
  });

  it("returns an empty set when the binding says it can be empty", async () => {
    const r = await adapter({ "protected.activeValues": "actve", "protected.allowEmpty": true }).protectedAccounts({}, ctx());
    assert.deepEqual(r, { ok: true, value: { items: [] } });
  });

  it("returns an account with no domain as it is, for the engine to refuse", async () => {
    state.customers = [{ sub: "active", dom: null, cust: null, nm: "Unknown" }];
    const r = await adapter().protectedAccounts({}, ctx());
    assert.deepEqual(r, { ok: true, value: { items: [{ name: "Unknown", reason: "customer" }] } });
  });

  it("is an error, not a short set, when a page fails partway", async () => {
    const t = adapter();
    const first = await t.protectedAccounts({ limit: 1 }, ctx());
    assert.ok(first.ok && first.value.nextCursor, JSON.stringify(first));
    state.forceStatus = 503;
    state.forceReason = "backendError";
    const second = await t.protectedAccounts({ limit: 1, cursor: first.value.nextCursor }, ctx());
    assert.ok(!second.ok && second.error.code === "unavailable" && second.error.retryable, JSON.stringify(second));
  });

  it("is an error when the result ends short of the rows it announced", async () => {
    state.shortBy = 1;
    const r = await adapter().protectedAccounts({}, ctx());
    assert.ok(!r.ok && /ended after 2 of the 3 rows/.test(r.error.message), JSON.stringify(r));
  });

  it("refuses params: the protected set is read whole", async () => {
    const r = await adapter().protectedAccounts({ params: { region: "north" } }, ctx());
    assert.ok(!r.ok && r.error.code === "invalid", JSON.stringify(r));
  });
});

describe("jobs", () => {
  it("waits for a job that is not complete, on the job, without running the query twice", async () => {
    state.incomplete = 2;
    const r = await adapter().protectedAccounts({}, ctx());
    assert.ok(r.ok && r.value.items.length === 2, JSON.stringify(r));
    assert.equal(posted().length, 1);
    assert.equal(seen.filter((s) => s.method === "GET").length, 2);
  });

  it("gives up on a job that never completes within the deadline", async () => {
    state.incomplete = Number.POSITIVE_INFINITY;
    const r = await adapter({ timeoutMs: 300 }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /did not complete within 300 ms/.test(r.error.message), JSON.stringify(r));
  });

  it("gives up on a warehouse that never answers", async () => {
    state.hang = true;
    const r = await adapter({ timeoutMs: 200 }).freshness("protected", ctx());
    assert.ok(!r.ok && r.error.code === "unavailable" && /no answer within 200 ms/.test(r.error.message), JSON.stringify(r));
  });

  it("trusts a complete job only with a schema", async () => {
    state.noSchema = true;
    const r = await adapter().protectedAccounts({}, ctx());
    assert.ok(!r.ok && /completed without a result: it failed/.test(r.error.message), JSON.stringify(r));
  });

  it("refuses an empty page that says another follows", async () => {
    state.emptyPage = true;
    const r = await adapter().protectedAccounts({}, ctx());
    assert.ok(!r.ok && /empty page that is not the last/.test(r.error.message), JSON.stringify(r));
  });

  it("caps what a query may bill, when the binding says so", async () => {
    await adapter({ maximumBytesBilled: 50_000_000, location: "EU" }).freshness("protected", ctx());
    assert.equal(posted()[0]?.maximumBytesBilled, "50000000");
    assert.equal(posted()[0]?.location, "EU");
  });

  it("reads the reason, not only the status: 403 is both denied and slow down", async () => {
    for (const [status, reason, code, retryable] of [
      [403, "accessDenied", "unauthorized", false],
      [403, "rateLimitExceeded", "rate_limited", true],
      [403, "quotaExceeded", "rate_limited", false],
      [400, "invalidQuery", "invalid", false],
      [404, "notFound", "not_found", false],
      [500, "backendError", "unavailable", true],
    ] as const) {
      state.forceStatus = status;
      state.forceReason = reason;
      const r = await adapter().freshness("protected", ctx());
      assert.ok(!r.ok && r.error.code === code && r.error.retryable === retryable && r.error.providerCode === reason, `${reason}: ${JSON.stringify(r)}`);
    }
  });
});

describe("probe", () => {
  it("dry-runs both age queries, which bill nothing, and reads no row", async () => {
    assert.deepEqual(await adapter().probe!(ctx()), { ok: true, value: undefined });
    assert.deepEqual(posted().map((b) => [b.dryRun, /`(\w+)`$/.exec(String(b.query))?.[1]]), [[true, "targets"], [true, "customers"]]);
  });

  it("fails on a table it cannot see", async () => {
    const r = await adapter({ "protected.table": "missing" }).probe!(ctx());
    assert.ok(!r.ok && r.error.code === "not_found", JSON.stringify(r));
  });
});

/* -------------------------------------------------------------------------- */
/* What each query reads, pinned                                               */
/* -------------------------------------------------------------------------- */

/**
 * The PR states what each query scans; these pin it, so a column added to a
 * query changes a test as well as a bill.
 */
describe("the columns each query reads", () => {
  const route = { table: "`p`.`d`.`t`", extractedAt: "x", freshness: "oldest" as const, domain: "dom" };
  const columns = (sql: string) => [...new Set([...sql.matchAll(/`(\w+)`/g)].map(([, c]) => c))].filter((c) => !["p", "d", "t"].includes(c!)).sort();

  it("freshness reads the extraction column only", () => {
    assert.deepEqual(columns(freshnessSql(route)), ["x"]);
  });

  it("candidates read status, domain, and the optional id, company id and name", () => {
    assert.deepEqual(columns(candidatesSql({ ...route, statusColumn: "st", companyId: "cid", id: "tid", name: "nm" })), ["cid", "dom", "nm", "st", "tid"]);
  });

  it("the protected set reads active, domain, and the optional id and name", () => {
    assert.deepEqual(
      columns(protectedSql({ ...route, activeColumn: "sub", activeValues: ["a"], reason: "customer", allowEmpty: false, id: "cust", name: "nm" })),
      ["cust", "dom", "nm", "sub"],
    );
  });
});

describe("the endpoint surface", () => {
  it("reaches the network through one function only", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1, "fetch is called outside `send`");
  });
});
