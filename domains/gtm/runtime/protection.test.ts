/**
 * Tests for reading the protected set (decisions 0019, 0033).
 *
 * No database: protection is a read and a set of matches, and nothing here
 * writes. Each test isolates one rule — a fixture that two rules would both
 * refuse proves neither (CLAUDE.md §5).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CallContext } from "@werunfoundry/core/contracts/types";

import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";
import { readProtection } from "./protection.js";

const NOW = new Date("2026-06-01T12:00:00Z");
const ctx: CallContext = { runId: "r", actor: { type: "system" }, dryRun: true };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** A target list whose protected route answers `accounts`, built `builtAt`. */
const source = (accounts: ProtectedAccount[], builtAt = minutesAgo(5)): TargetList =>
  ({
    provider: "memory",
    async freshness() {
      return { ok: true, value: { route: "protected", asOf: builtAt } };
    },
    async protectedAccounts() {
      return { ok: true, value: { items: accounts } };
    },
    async candidates() {
      return { ok: true, value: { items: [] } };
    },
  }) as unknown as TargetList;

const byId = (value: string, network = "net_a") => ({ subject: "company", keys: [{ kind: "social_company_id", network, value }] });
const account = (a: { domain?: string; id?: string; network?: string; customer?: string; name?: string }): ProtectedAccount => ({
  ...(a.domain ? { domain: a.domain } : {}),
  ...(a.customer ? { customerId: a.customer } : {}),
  ...(a.name ? { name: a.name } : {}),
  ...(a.id || a.domain
    ? { identity: { subject: "company", keys: [...(a.domain ? [{ kind: "domain", value: a.domain }] : []), ...(a.id ? byId(a.id, a.network).keys : [])] } }
    : {}),
  reason: "customer",
});
const candidate = (c: { domain?: string; id?: string; network?: string }): TargetCompany => ({
  ...(c.domain ? { domain: c.domain } : {}),
  ...(c.id ? { identity: byId(c.id, c.network) } : {}),
  attributes: {},
});

async function read(accounts: ProtectedAccount[], builtAt?: string, acknowledged?: Set<string>) {
  const r = await readProtection(source(accounts, builtAt), { maxAgeMinutes: 60, now: NOW, ...(acknowledged ? { acknowledged } : {}) }, ctx);
  if (!r.ok) throw new Error(`protection stopped: ${r.stop}`);
  return r.protection;
}

describe("protection matches on either key", () => {
  it("protects a company by its domain alone", async () => {
    const p = await read([account({ domain: "client.example.com" })]);
    assert.equal(p.company(candidate({ domain: "client.example.com" })), true);
    assert.equal(p.company(candidate({ domain: "other.example.com" })), false);
  });

  // The candidate's domain is not the account's: only the company id ties them.
  it("protects a company by its company id alone, whatever its domain", async () => {
    const p = await read([account({ domain: "client.example.com", id: "4242" })]);
    assert.equal(p.company(candidate({ domain: "rebranded.example.org", id: "4242" })), true);
    assert.equal(p.company(candidate({ domain: "rebranded.example.org", id: "4343" })), false);
  });

  it("does not match the same id on another network", async () => {
    const p = await read([account({ domain: "client.example.com", id: "4242", network: "net_a" })]);
    assert.equal(p.company(candidate({ domain: "x.example.org", id: "4242", network: "net_b" })), false);
  });
});

describe("protection is not an identity source", () => {
  it("reads two builds that name a different company id for one domain, each without complaint", async () => {
    const first = await read([account({ domain: "shared.example.com", id: "1001" })]);
    const second = await read([account({ domain: "shared.example.com", id: "2002" })]);
    // The domain protects in both; each id protects while its build is read.
    assert.equal(first.company(candidate({ domain: "shared.example.com" })), true);
    assert.equal(second.company(candidate({ domain: "shared.example.com" })), true);
    assert.equal(first.company(candidate({ domain: "elsewhere.example.net", id: "1001" })), true);
    assert.equal(second.company(candidate({ domain: "elsewhere.example.net", id: "2002" })), true);
    assert.equal(second.company(candidate({ domain: "elsewhere.example.net", id: "1001" })), false);
  });

  it("reads one build where a domain carries several company ids, without complaint", async () => {
    const p = await read([account({ domain: "shared.example.com", id: "1001" }), account({ domain: "shared.example.com", id: "1002" })]);
    assert.equal(p.company(candidate({ domain: "z.example.net", id: "1001" })), true);
    assert.equal(p.company(candidate({ domain: "z.example.net", id: "1002" })), true);
  });
});

describe("protection counts accounts, not rows", () => {
  it("counts rows that share a key as one account", async () => {
    const p = await read([
      account({ domain: "nine.example.com", id: "1" }),
      account({ domain: "nine.example.com", id: "2" }),
      account({ domain: "nine.example.com", id: "3" }),
      // Joined to the three above through id 3.
      account({ domain: "nine-alias.example.com", id: "3" }),
      account({ domain: "alone.example.org" }),
    ]);
    assert.deepEqual([p.accounts, p.rows], [2, 5]);
  });
});

describe("protection fails closed", () => {
  it("stops when the set was built longer ago than allowed", async () => {
    const r = await readProtection(source([account({ domain: "client.example.com" })], minutesAgo(61)), { maxAgeMinutes: 60, now: NOW }, ctx);
    assert.ok(!r.ok && /61 minutes old, older than the 60 allowed/.test(r.stop), JSON.stringify(r));
  });

  it("stops on an account with no key at all", async () => {
    const r = await readProtection(source([account({ domain: "client.example.com" }), account({})]), { maxAgeMinutes: 60, now: NOW }, ctx);
    assert.ok(!r.ok && /neither a domain, a company id nor an identifier/.test(r.stop), JSON.stringify(r));
  });
});

describe("customers: counted, acknowledged, never matched (0034)", () => {
  it("counts customers, not the rows they hold, and says what is matched on", async () => {
    const p = await read([
      account({ domain: "a.example.com", id: "1", customer: "cust-a" }),
      account({ domain: "a2.example.com", customer: "cust-a" }),
      account({ domain: "a.example.com", id: "2", customer: "cust-a" }),
      account({ domain: "b.example.org", customer: "cust-b" }),
    ]);
    assert.deepEqual([p.accounts, p.rows], [2, 4]);
    assert.deepEqual(p.surface, { domains: 3, companyIds: 2 });
  });

  it("lets a row with no key pass when its customer is protected through another row, and counts it", async () => {
    const p = await read([account({ domain: "a.example.com", customer: "cust-a" }), account({ customer: "cust-a" })]);
    assert.equal(p.unkeyedRowsOfCoveredCustomers, 1);
    assert.deepEqual(p.uncovered, []);
  });

  it("stops on a customer with no key on any row that nobody acknowledged, naming it", async () => {
    const r = await readProtection(
      source([account({ domain: "a.example.com", customer: "cust-a" }), account({ customer: "cust-z", name: "Zed" }), account({ customer: "cust-z" })]),
      { maxAgeMinutes: 60, now: NOW },
      ctx,
    );
    assert.ok(!r.ok && /1 protected customer has no key on any row/.test(r.stop) && /cust-z \(Zed\), 2 rows/.test(r.stop), JSON.stringify(r));
  });

  it("goes on past an acknowledged uncovered customer, and reports it", async () => {
    const p = await read([account({ domain: "a.example.com", customer: "cust-a" }), account({ customer: "cust-z", name: "Zed" })], undefined, new Set(["cust-z"]));
    assert.deepEqual(p.uncovered, [{ customerId: "cust-z", name: "Zed", rows: 1 }]);
  });

  it("still stops on an uncovered customer when another one is acknowledged", async () => {
    const r = await readProtection(
      source([account({ customer: "cust-y" }), account({ customer: "cust-z" }), account({ domain: "a.example.com", customer: "cust-a" })]),
      { maxAgeMinutes: 60, now: NOW, acknowledged: new Set(["cust-z"]) },
      ctx,
    );
    assert.ok(!r.ok && /cust-y/.test(r.stop) && !/cust-z/.test(r.stop), JSON.stringify(r));
  });

  // The candidate's own identifier is the customer id: matching on it would protect it.
  it("never matches a candidate on the customer id", async () => {
    const p = await read([account({ domain: "a.example.com", customer: "cust-9" })]);
    assert.equal(p.company({ externalId: "cust-9", domain: "b.example.org", attributes: {} }), false);
  });
});
