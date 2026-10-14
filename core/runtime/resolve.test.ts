/**
 * Tests for the binding resolver.
 *
 * They inject the importer and the environment, so nothing here touches a
 * filesystem or a real variable. That is not only convenience: it is what
 * makes it possible to assert on the failure cases, which are most of them —
 * a resolver's job is almost entirely to refuse things clearly.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { Contract } from "../contracts/types.js";
import type { InstanceManifest, ProviderBinding } from "../manifest/types.js";
import { resolveAdapters } from "./resolve.js";

const manifestWith = (...providers: ProviderBinding[]): InstanceManifest => ({
  instance: "test",
  enabledDomains: ["relations"],
  providers,
  truthsDir: "truths",
});

const binding = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  contract: "crm",
  adapter: "@example/adapter",
  env: [],
  ...over,
});

/** A module shaped the way an adapter module is supposed to be shaped. */
const adapterModule = (
  build: (init: { options: Record<string, unknown>; env: Record<string, unknown> }) => unknown =
    () => ({ provider: "example" }),
) => ({ default: build });

const resolve = (
  manifest: InstanceManifest,
  modules: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
) =>
  resolveAdapters(manifest, {
    root: "/instance",
    env,
    importModule: async (specifier) => {
      const found = modules[specifier];
      if (!found) throw new Error(`Cannot find module '${specifier}'`);
      return found;
    },
  });

const firstIssue = (r: { issues: { at: string; message: string }[] }) =>
  `${r.issues[0]?.at} ${r.issues[0]?.message}`;

describe("resolving a binding", () => {
  it("builds the adapter and files it under its contract", async () => {
    const r = await resolve(manifestWith(binding()), {
      "@example/adapter": adapterModule(),
    });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    assert.equal(r.registry?.require<Contract>("crm").provider, "example");
    assert.equal(r.registry?.list().length, 1);
  });

  it("resolves a relative specifier against the instance root", async () => {
    const r = await resolve(
      manifestWith(binding({ adapter: "./adapters/mine.ts" })),
      { "file:///instance/adapters/mine.ts": adapterModule() },
    );
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  });

  it("leaves a package specifier alone", async () => {
    const r = await resolve(manifestWith(binding({ adapter: "@scope/pkg" })), {
      "@scope/pkg": adapterModule(),
    });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  });
});

describe("what it hands the factory", () => {
  it("passes only the variables the binding declared", async () => {
    let seen: Record<string, unknown> = {};
    const r = await resolve(
      manifestWith(binding({ env: ["WANTED"] })),
      { "@example/adapter": adapterModule((init) => { seen = init.env; return { provider: "x" }; }) },
      { WANTED: "yes", OTHER: "should not be visible" },
    );
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    assert.deepEqual(Object.keys(seen), ["WANTED"]);
  });

  it("passes the binding's options", async () => {
    let seen: Record<string, unknown> = {};
    const r = await resolve(
      manifestWith(binding({ options: { baseUrl: "https://example.invalid" } })),
      { "@example/adapter": adapterModule((init) => { seen = init.options; return { provider: "x" }; }) },
    );
    assert.equal(r.ok, true);
    assert.equal(seen.baseUrl, "https://example.invalid");
  });

  it("refuses a declared variable that is not set, at startup", async () => {
    const r = await resolve(manifestWith(binding({ env: ["MISSING"] })), {
      "@example/adapter": adapterModule(),
    });
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /MISSING is declared but not set/);
  });

  it("treats an empty string as not set, because it is", async () => {
    const r = await resolve(
      manifestWith(binding({ env: ["EMPTY"] })),
      { "@example/adapter": adapterModule() },
      { EMPTY: "" },
    );
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /EMPTY is declared but not set/);
  });
});

describe("what it refuses", () => {
  it("a module that cannot be loaded", async () => {
    const r = await resolve(manifestWith(binding({ adapter: "./nope.ts" })), {});
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /cannot be loaded/);
  });

  it("a module with no default export", async () => {
    const r = await resolve(manifestWith(binding()), { "@example/adapter": { notDefault: 1 } });
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /must export a factory/);
  });

  it("a default export that is not a function", async () => {
    const r = await resolve(manifestWith(binding()), {
      "@example/adapter": { default: { provider: "already built" } },
    });
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /must export a factory/);
  });

  it("a factory that throws instead of building", async () => {
    const r = await resolve(manifestWith(binding()), {
      "@example/adapter": adapterModule(() => {
        throw new Error("reached for the network");
      }),
    });
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /failed to build: reached for the network/);
  });

  it("something built that does not name its provider", async () => {
    const r = await resolve(manifestWith(binding()), {
      "@example/adapter": adapterModule(() => ({ findPersonByEmail() {} })),
    });
    assert.equal(r.ok, false);
    assert.match(firstIssue(r), /does not name its provider/);
  });

  it("reports every binding's problem at once, not the first", async () => {
    const r = await resolve(
      manifestWith(
        binding({ contract: "crm", env: ["A_MISSING"] }),
        binding({ contract: "sequencer", adapter: "./gone.ts" }),
      ),
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.issues.length, 2, JSON.stringify(r.issues));
    assert.ok(r.issues.some((i) => i.at.startsWith("providers.0")));
    assert.ok(r.issues.some((i) => i.at.startsWith("providers.1")));
  });

  it("hands back no registry at all when anything failed", async () => {
    const r = await resolve(manifestWith(binding({ env: ["MISSING"] })), {
      "@example/adapter": adapterModule(),
    });
    assert.equal(r.registry, undefined);
  });
});

describe("the registry", () => {
  it("returns undefined for a contract nobody bound", async () => {
    const r = await resolve(manifestWith(binding()), { "@example/adapter": adapterModule() });
    assert.equal(r.registry?.get("sequencer"), undefined);
  });

  it("throws on require for one nobody bound, because no run survives it", async () => {
    const r = await resolve(manifestWith(binding()), { "@example/adapter": adapterModule() });
    assert.throws(() => r.registry?.require("sequencer"), /no adapter is bound/);
  });
});
