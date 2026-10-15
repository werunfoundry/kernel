/**
 * The example CRM adapter's deadline: a provider that stops answering must
 * become an error the run can report, never a run that never ends.
 *
 *   node --test adapters/
 */

import { strict as assert } from "node:assert";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import factory from "./example-crm.ts";

const hung: ServerResponse[] = [];
const server = createServer((_req, res) => {
  hung.push(res); // never answers
});
let baseUrl = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  for (const res of hung.splice(0)) res.destroy();
  server.closeAllConnections();
  server.close();
});

describe("the example CRM adapter", () => {
  it("returns unavailable when the provider never answers, instead of hanging", async () => {
    const crm = factory({ options: { baseUrl, timeoutMs: 200 }, env: { EXAMPLE_CRM_TOKEN: "test-token" } });
    const started = Date.now();
    const r = await crm.findPersonByEmail("ada@example.com", { runId: "r", actor: { type: "system" }, dryRun: true });
    assert.ok(!r.ok && r.error.code === "unavailable" && /no answer within 200 ms/.test(r.error.message), JSON.stringify(r));
    assert.ok(r.ok || r.error.retryable);
    assert.ok(Date.now() - started < 5_000);
  });
});
