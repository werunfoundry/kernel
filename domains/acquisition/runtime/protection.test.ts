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

describe("a domain is matched by its ancestors, and what is not a host fails closed (0044)", () => {
  const protectedSet = () => read([account({ domain: "11x.example.com", id: "9843" }), account({ domain: "dcx.uni.example.org" })]);

  it("protects a subdomain of a protected domain, at any depth", async () => {
    const p = await protectedSet();
    for (const d of ["app.11x.example.com", "go.11x.example.com", "a.b.11x.example.com"]) assert.equal(p.verdict(candidate({ domain: d })), "protected", d);
  });

  it("keeps the spellings 0028 already reduced", async () => {
    const p = await protectedSet();
    for (const d of ["11x.example.com/demo", "www.11x.example.com", "11X.EXAMPLE.COM", "https://11x.example.com", "11x.example.com."]) {
      assert.equal(p.verdict(candidate({ domain: d })), "protected", d);
    }
  });

  it("protects a doubled www. through its ancestor", async () => {
    const p = await protectedSet();
    assert.equal(p.verdict(candidate({ domain: "www.www.11x.example.com" })), "protected");
  });

  it("does not move the protected set: a protected subdomain protects what is under it, not its parent or its siblings", async () => {
    const p = await protectedSet();
    assert.equal(p.verdict(candidate({ domain: "x.dcx.uni.example.org" })), "protected");
    assert.equal(p.verdict(candidate({ domain: "uni.example.org" })), "clear");
    assert.equal(p.verdict(candidate({ domain: "other.uni.example.org" })), "clear");
  });

  it("excludes a domain that is not a host, under its own reason, and lets clear ones pass", async () => {
    const p = await protectedSet();
    for (const d of ["11x .example.com", "[www.11x.example.com](https://www.11x.example.com)", "not a domain at all", "localhost", "http://"]) {
      assert.equal(p.verdict(candidate({ domain: d })), "unreadable_key", d);
      assert.equal(p.company(candidate({ domain: d })), true, `${d}: company() lets it through`);
    }
    for (const d of ["nobody-here-7f3a91.example.com", "witness-negative.example.org"]) assert.equal(p.verdict(candidate({ domain: d })), "clear", d);
  });

  it("calls an unreadable domain protected when another key protects it", async () => {
    const p = await protectedSet();
    assert.equal(p.verdict(candidate({ domain: "11x .example.com", id: "9843" })), "protected");
  });

  it("walks the ancestors of a person's address too", async () => {
    const p = await protectedSet();
    assert.equal(p.person({ subject: "person", keys: [{ kind: "email", value: "ada@mail.11x.example.com" }] }), true);
    assert.equal(p.person({ subject: "person", keys: [{ kind: "email", value: "ada@uni.example.org" }] }), false);
  });

  it("stops on a protected row whose domain is not a host, and still reads a blank one as no domain", async () => {
    const r = await readProtection(source([account({ domain: "11x .example.com" })]), { maxAgeMinutes: 60, now: NOW }, ctx);
    assert.ok(!r.ok && /a protected row's domain is not a host: "11x \.example\.com"/.test(r.stop), JSON.stringify(r));
    const single = await readProtection(source([account({ domain: "localhost" })]), { maxAgeMinutes: 60, now: NOW }, ctx);
    assert.ok(!single.ok, "a one-label domain was read as a host");
    await read([account({ domain: "  ", id: "77" })]);
  });

  it("counts, per protected entry, the distinct candidates it excluded", async () => {
    const p = await protectedSet();
    p.verdict(candidate({ domain: "app.11x.example.com" }));
    p.verdict(candidate({ domain: "app.11x.example.com" }));
    p.verdict(candidate({ domain: "go.11x.example.com" }));
    p.verdict(candidate({ domain: "elsewhere.example.net", id: "9843" }));
    p.verdict(candidate({ domain: "nobody-here.example.com" }));
    assert.deepEqual(p.hits(), [
      { entry: "11x.example.com", candidates: 2 },
      { entry: "social_company_id@net_a 9843", candidates: 1 },
    ]);
  });
});

describe("an account known by the source's own identifier alone (0068)", () => {
  const bySource = (externalId: string, more: Partial<ProtectedAccount> = {}): ProtectedAccount => ({ externalId, reason: "customer", ...more });

  it("is listed, once, with its name, and still matched against a candidate that carries the identifier", async () => {
    const p = await read([bySource("acct-7", { name: "Seven" }), bySource("acct-7"), account({ domain: "client.example.com" })]);
    assert.deepEqual(p.bySourceIdOnly, [{ externalId: "acct-7", name: "Seven" }]);
    assert.equal(p.company({ externalId: "acct-7", domain: "renamed.example.org", attributes: {} }), true);
  });

  it("is not listed when the account also carries a domain or a company id: those match a company on record", async () => {
    const p = await read([bySource("acct-1", { domain: "one.example.com" }), bySource("acct-2", { identity: byId("42") })]);
    assert.deepEqual(p.bySourceIdOnly, []);
  });

  it("is not listed when another row carries the same identifier beside a domain", async () => {
    const p = await read([bySource("acct-3"), bySource("acct-3", { domain: "three.example.com" })]);
    assert.deepEqual(p.bySourceIdOnly, []);
  });
});
