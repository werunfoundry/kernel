/**
 * Tests for the HTTP API (decision 0040): over a real socket, against a real
 * database. The token is required on every route, a person cannot act, and
 * the routes served are exactly the ones the OpenAPI document describes.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { loadDomain } from "@werunfoundry/core/manifest/load";
import type { Database } from "@werunfoundry/core/runtime/run";

import { createApi, routes } from "./server.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_api_${process.pid}`;
const token = "t".repeat(40);
let admin: Client;
let client: Client;
let server: Server;
let origin = "";

const domains = ["relations", "acquisition"].map((d) => loadDomain(join(import.meta.dirname, `../domains/${d}/domain.yaml`)).manifest!);
const spec = JSON.parse(readFileSync(join(import.meta.dirname, "openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const url = new URL(base);
  url.pathname = `/${database}`;
  client = new Client({ connectionString: url.toString() });
  await client.connect();
  for (const layer of ["../core", "../domains/relations", "../domains/acquisition"]) {
    const dir = join(import.meta.dirname, layer, "db/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await client.query(readFileSync(join(dir, f), "utf8"));
  }
  server = createServer(createApi({ db: drizzle(client) as unknown as Database, domains, token }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  await client?.end();
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

beforeEach(async () => {
  if (client) await client.query("truncate acquisition.draft, relations.person, core.experiment, core.run cascade");
});

const call = (method: string, path: string, opts: { body?: unknown; auth?: string | null } = {}) =>
  fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(opts.auth === null ? {} : { authorization: `Bearer ${opts.auth ?? token}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
const rows = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
const concrete = (path: string) => path.replace(/\{id\}/g, "00000000-0000-4000-8000-000000000000");

async function fixtures() {
  const [{ id: personId }] = await rows("insert into relations.person (email) values ('ada@example.com') returning id");
  const [{ id: experimentId }] = await rows("insert into core.experiment (slug, type, hypothesis_ref, status) values ('e', 'campaign', 'https://example.com/h', 'running') returning id");
  return { personId, experimentId };
}

describe("the contract", () => {
  it("serves exactly the operations the OpenAPI document describes", () => {
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`)).sort();
    assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), documented);
  });

  it("refuses to exist without a token long enough to be one", () => {
    assert.throws(() => createApi({ db: {} as Database, domains, token: "short" }), /at least 32/);
  });
});

describe("the API", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  it("refuses every operation without the instance's token, or with another", async () => {
    for (const r of routes) {
      for (const auth of [null, "x".repeat(40)]) {
        const res = await call(r.method.toUpperCase(), concrete(r.path) + (r.path === "/v1/drafts" ? "?state=approved" : ""), { auth, ...(r.method === "post" ? { body: {} } : {}) });
        assert.equal(res.status, 401, `${r.method} ${r.path} with ${auth === null ? "no token" : "another token"}`);
      }
    }
  });

  it("answers with the token", async () => {
    assert.deepEqual(await (await call("GET", "/v1/health")).json(), { ok: true });
  });

  it("lets an agent propose a draft, which waits on its lane", async () => {
    const { personId, experimentId } = await fixtures();
    const res = await call("POST", "/v1/drafts", { body: { experimentId, personId, step: 1, renderedBody: "Hello", autonomyAfter: 5, actor: { type: "agent", id: "writer" } } });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { outcome: string; draft: { state: string } };
    assert.deepEqual([body.outcome, body.draft.state], ["awaiting_review", "awaiting_review"]);
    const listed = (await (await call("GET", "/v1/drafts?state=awaiting_review")).json()) as { drafts: unknown[] };
    assert.equal(listed.drafts.length, 1);
  });

  it("lets a reactive lane approve an agent's reply when the person reached us inside the window (decision 0042)", async () => {
    const { personId, experimentId } = await fixtures();
    await client.query("update core.experiment set lane = 'reactive' where id = $1", [experimentId]);
    const [{ id: templateId }] = await rows("insert into acquisition.template (experiment_id, variant, step, channel, body) values ($1, 'a', 1, 'email', 'Hello') returning id", [experimentId]);
    await client.query(
      "insert into relations.touch (person_id, channel, direction, unsolicited, provider, provider_event_id, occurred_at, actor_type) values ($1, 'email', 'inbound', false, 'memory', 'r1', now(), 'system')",
      [personId],
    );
    const res = await call("POST", "/v1/drafts", { body: { experimentId, personId, step: 1, templateId, renderedBody: "Thanks", autonomyAfter: 5, reactiveWithinMinutes: 60, actor: { type: "agent" } } });
    assert.equal(res.status, 201);
    assert.deepEqual(((await res.json()) as { draft: { decidedBy: string } }).draft.decidedBy, "lane:reactive");
  });

  it("refuses a person as the actor, and writes nothing", async () => {
    const { personId, experimentId } = await fixtures();
    const res = await call("POST", "/v1/drafts", { body: { experimentId, personId, step: 1, renderedBody: "Hello", autonomyAfter: 5, actor: { type: "human", id: "someone" } } });
    assert.equal(res.status, 403);
    assert.equal((await rows("select count(*)::int as n from acquisition.draft"))[0].n, 0);
  });

  it("refuses a body with a field the operation does not take", async () => {
    const { personId, experimentId } = await fixtures();
    const res = await call("POST", "/v1/drafts", { body: { experimentId, personId, step: 1, renderedBody: "Hello", autonomyAfter: 5, actor: { type: "agent" }, state: "approved" } });
    assert.equal(res.status, 400);
  });

  it("shows the erasure plan, and changes nothing", async () => {
    const { personId } = await fixtures();
    const res = await call("GET", `/v1/people/${personId}/erasure`);
    const { steps, notReached } = (await res.json()) as { steps: { table: string; rows: number }[]; notReached: string[] };
    assert.deepEqual(steps.find((s) => s.table === "person"), { domain: "relations", table: "person", column: "id", do: "delete", rows: 1 });
    assert.deepEqual(steps.find((s) => s.table === "sourcing_result"), { domain: "acquisition", table: "sourcing_result", column: "person_id", keys: "person", do: "anonymise", rows: 0, byKeys: 0 });
    assert.ok(notReached.some((n) => n.startsWith("backups")) && notReached.some((n) => n.includes("opt-out")), "the plan says what it does not reach (0049)");
    assert.ok(notReached.some((n) => n.startsWith("the sequencer:")), "the plan says it does not reach the sequencer");
    assert.equal((await rows("select count(*)::int as n from relations.person"))[0].n, 1);
  });

  it("reads a run, and says when there is none", async () => {
    const [{ id }] = await rows("insert into core.run (process_key, trigger, actor_type) values ('t', 'cli', 'system') returning id");
    assert.equal(((await (await call("GET", `/v1/runs/${id}`)).json()) as { processKey: string }).processKey, "t");
    assert.equal((await call("GET", concrete("/v1/runs/{id}"))).status, 404);
  });
});
