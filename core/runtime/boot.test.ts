/**
 * Tests for boot.
 *
 * Nothing is injected here, on purpose. Boot's whole job is to find things
 * where an instance installed them, and the resolver's first version passed
 * its tests while unable to load a single published adapter — because those
 * tests supplied the importer. So each test below builds a real instance in a
 * temporary directory, with a real `node_modules`, and lets Node resolve.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { boot } from "./boot.js";

const kernel = join(import.meta.dirname, "../..");
const made: string[] = [];

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * An instance on disk. `domains` are the kernel's own packages, linked the way
 * pnpm links them; `files` is everything else, paths relative to the root.
 */
function instance(files: Record<string, string>, domains: string[] = ["relations", "gtm"]): string {
  const root = mkdtempSync(join(tmpdir(), "instance-"));
  made.push(root);
  for (const name of domains) {
    const link = join(root, "node_modules/@werunfoundry", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(kernel, "domains", name), link, "dir");
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

/** An adapter in plain JavaScript, so the test does not depend on a loader. */
const ADAPTER = "export default () => ({ provider: 'fixture' });\n";

const manifest = (lines: string[]) => [`instance: test`, `truthsDir: truths`, ...lines, ""].join("\n");

const messages = (r: { issues: { at: string; message: string }[] }) =>
  r.issues.map((i) => `${i.at.replace(/^.*manifest\.yaml:/, "")} ${i.message}`);

describe("booting an instance", () => {
  it("boots the template as it ships, every contract bound to a sandbox", async () => {
    const r = await boot({ root: join(kernel, "template"), env: {} });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual(r.domains.map((d) => d.name), ["relations", "gtm"]);
    assert.deepEqual(
      r.registry.list().map((a) => `${a.contract}:${a.provider}`),
      [
        "target_list:sandbox-target-list",
        "enrichment:sandbox-enrichment",
        "sequencer:sandbox-sequencer",
        "inbound:sandbox-inbound",
        "metrics:sandbox-metrics",
        "crm:sandbox-crm",
      ],
    );
    assert.ok(r.registry.forChannel("sequencer", "email"));
  });

  it("returns the manifest, the domains and the registry", async () => {
    const root = instance({
      "manifest.yaml": manifest([
        "enabledDomains: [relations]",
        "providers:",
        "  - { contract: crm, adapter: ./adapters/crm.mjs, env: [TOKEN] }",
      ]),
      "adapters/crm.mjs": ADAPTER,
    }, ["relations"]);
    const r = await boot({ root, env: { TOKEN: "x" } });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.equal(r.manifest.instance, "test");
    assert.deepEqual(r.domains.map((d) => d.name), ["relations"]);
    assert.equal(r.registry.list().length, 1);
  });

  it("reports every problem at once, not the first", async () => {
    const root = instance({
      "manifest.yaml": manifest([
        "enabledDomains: [gtm, nowhere]",
        "providers:",
        "  - { contract: crm, adapter: ./adapters/crm.mjs, env: [MISSING] }",
        "  - { contract: sequencer, adapter: ./adapters/absent.mjs, env: [] }",
      ]),
      "adapters/crm.mjs": ADAPTER,
    });
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    const said = messages(r).join("\n");
    assert.match(said, /enabledDomains\.0 "gtm" depends on "relations", which is not enabled/);
    assert.match(said, /enabledDomains\.1 @werunfoundry\/nowhere is not installed/);
    assert.match(said, /providers\.0\.env MISSING is declared but not set/);
    assert.match(said, /providers\.1\.adapter cannot be loaded/);
  });

  it("says one thing about a domain that is not installed, and what to do", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, gtm]", "providers: []"]),
    }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.deepEqual(messages(r), [
      "enabledDomains.1 @werunfoundry/gtm is not installed in this instance — add it to its package.json dependencies",
    ]);
  });

  it("refuses a package that does not export a domain.yaml", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [plain]", "providers: []"]),
      "node_modules/@werunfoundry/plain/package.json":
        '{ "name": "@werunfoundry/plain", "type": "module", "exports": { ".": "./index.js" } }\n',
      "node_modules/@werunfoundry/plain/index.js": "export {};\n",
      "node_modules/@werunfoundry/plain/domain.yaml": "name: plain\n",
    }, []);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /exports nothing for "\.\/domain\.yaml"/);
  });

  it("refuses a package whose domain.yaml names another domain", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [alias]", "providers: []"]),
      "node_modules/@werunfoundry/alias/package.json":
        '{ "name": "@werunfoundry/alias", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
      "node_modules/@werunfoundry/alias/domain.yaml":
        "name: other\nversion: 0.0.0\ndescription: x\nschema: other\ndependsOn: []\n",
    }, []);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /declares itself "other"/);
  });

  it("finds a published adapter where the instance installed it", async () => {
    const root = instance({
      "manifest.yaml": manifest([
        "enabledDomains: [relations]",
        "providers:",
        "  - { contract: crm, adapter: '@fixture/adapter', env: [] }",
      ]),
      "node_modules/@fixture/adapter/package.json":
        '{ "name": "@fixture/adapter", "type": "module", "exports": "./index.js" }\n',
      "node_modules/@fixture/adapter/index.js": ADAPTER,
    }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.equal(r.registry.require("crm").provider, "fixture");
  });

  it("explains an adapter published for import only, and says what to change", async () => {
    // The ordinary shape of a modern package, and the one decision 0007 says
    // cannot resolve. The message must say why and what to do, not blame the
    // package with Node's own words.
    const root = instance({
      "manifest.yaml": manifest([
        "enabledDomains: [relations]",
        "providers:",
        "  - { contract: crm, adapter: '@fixture/esm-only', env: [] }",
      ]),
      "node_modules/@fixture/esm-only/package.json":
        '{ "name": "@fixture/esm-only", "type": "module", "exports": { "import": "./index.js" } }\n',
      "node_modules/@fixture/esm-only/index.js": ADAPTER,
    }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    const said = messages(r).join("\n");
    assert.match(said, /providers\.0\.adapter cannot be loaded: @fixture\/esm-only is installed, but exports nothing for its main entry under the "require" or "default" condition/);
    assert.match(said, /add a "default" key beside "import"/);
    assert.doesNotMatch(said, /No "exports" main defined/);
  });

  it("loads the metrics gtm declares, and refuses a source that reads an undeclared one", async () => {
    const source = (...metrics: string[]) => `export default () => ({ provider: "fixture", metrics: ${JSON.stringify(metrics)} });\n`;
    const good = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, gtm]", "providers:", "  - { contract: metrics, adapter: ./adapters/m.mjs, env: [] }"]),
      "adapters/m.mjs": source("gtm.enrolled", "gtm.replied"),
    });
    const r = await boot({ root: good, env: {} });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (r.ok) {
      const judged = r.domains.find((d) => d.name === "gtm")?.experimentMetrics ?? {};
      // The guardrails are in every type, and offer_test reads replies.
      for (const [type, keys] of Object.entries(judged)) {
        assert.ok(keys.includes("gtm.bounced") && keys.includes("gtm.unsubscribed"), `${type} has no deliverability guardrail`);
      }
      assert.ok(judged.offer_test?.includes("gtm.replied"), "offer_test cannot tell nobody bit from replied without booking");
    }

    const bad = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, gtm]", "providers:", "  - { contract: metrics, adapter: ./adapters/m.mjs, env: [] }"]),
      "adapters/m.mjs": source("gtm.enrolled", "gtm.revenue"),
    });
    assert.match(messages(await boot({ root: bad, env: {} })).join("\n"), /reads "gtm.revenue", which no enabled domain declares/);
  });

  describe("a contract bound per channel (0015)", () => {
    /** An adapter that serves the given channels. */
    const serving = (...channels: string[]) =>
      `export default () => ({ provider: "fixture", channels: ${JSON.stringify(channels)} });\n`;
    const twoSequencers = (a: string, b: string, extra: string[] = []) =>
      instance({
        "manifest.yaml": manifest([
          "enabledDomains: [relations, gtm]",
          "providers:",
          `  - { contract: sequencer, adapter: ./adapters/a.mjs, env: []${extra[0] ?? ""} }`,
          `  - { contract: sequencer, adapter: ./adapters/b.mjs, env: []${extra[1] ?? ""} }`,
        ]),
        "adapters/a.mjs": a,
        "adapters/b.mjs": b,
      });

    it("binds one adapter per channel, and finds each by its channel", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), serving("social_message", "social_invite")), env: {} });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
      if (!r.ok) return;
      assert.ok(r.registry.forChannel("sequencer", "email"));
      assert.equal(r.registry.forChannel("sequencer", "social_invite"), r.registry.forChannel("sequencer", "social_message"));
      assert.notEqual(r.registry.forChannel("sequencer", "email"), r.registry.forChannel("sequencer", "social_message"));
      assert.equal(r.registry.forChannel("sequencer", "profile_visit"), undefined);
      assert.equal(r.registry.all("sequencer").length, 2);
      assert.throws(() => r.registry.get("sequencer"), /bound per channel/);
    });

    it("refuses two adapters claiming the same channel, naming both", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), serving("email", "social_message")), env: {} });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.1\.channels the channel "email" of contract "sequencer" is already taken by providers\.0; one adapter per channel/);
    });

    it("lets a binding narrow an adapter to some of its channels, which resolves the overlap", async () => {
      const r = await boot({
        root: twoSequencers(serving("email"), serving("email", "social_message"), ["", ", channels: [social_message]"]),
        env: {},
      });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
    });

    it("refuses a binding that assigns a channel the adapter does not serve", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), serving("social_message"), ["", ", channels: [social_invite]"]), env: {} });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /"social_invite" is not a channel this adapter serves/);
    });

    it("refuses a contract bound twice where a binding takes no channel", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), ADAPTER), env: {} });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /bound more than once, so each binding takes channels, and this one takes none/);
    });

    it("refuses a channel no enabled domain declares, whoever names it", async () => {
      const declaredByAdapter = await boot({ root: twoSequencers(serving("email"), serving("carrier_pigeon")), env: {} });
      assert.match(messages(declaredByAdapter).join("\n"), /no enabled domain declares the channel "carrier_pigeon"/);
      const namedByManifest = await boot({ root: twoSequencers(serving("email"), serving("social_message"), ["", ", channels: [carrier_pigeon]"]), env: {} });
      assert.match(messages(namedByManifest).join("\n"), /no enabled domain declares the channel "carrier_pigeon"/);
    });
  });

  it("carries the identity vocabulary the installed domains declare, and the instance's networks", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations]", "providers: []", "networks: [net_a]"]),
    }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual([...r.identity.kinds.keys()].sort(), ["domain", "email", "social_company_id", "social_profile_id"]);
    assert.deepEqual([...r.identity.subjects].sort(), ["company", "person"]);
    assert.deepEqual([...r.identity.networks], ["net_a"]);
  });

  it("refuses an identity key declared by two enabled domains", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, twin]", "providers: []"]),
      "node_modules/@werunfoundry/twin/package.json":
        '{ "name": "@werunfoundry/twin", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
      "node_modules/@werunfoundry/twin/domain.yaml":
        "name: twin\nversion: 0.0.0\ndescription: x\nschema: twin\ndependsOn: []\n" +
        "identityKeys:\n  - kind: email\n    subject: person\n    immutable: false\n",
    }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /"email" is declared by both "relations" and "twin"; a key two domains need belongs one layer down/);
  });

  it("refuses a network that is not an identifier", async () => {
    const root = instance({ "manifest.yaml": manifest(["enabledDomains: [relations]", "providers: []", "networks: [Net-A]"]) }, ["relations"]);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /networks\.0/);
  });

  it("reports a manifest that is not YAML, and does not throw", async () => {
    const root = instance({ "manifest.yaml": "instance: [unclosed\n" }, []);
    const r = await boot({ root, env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /is not valid YAML/);
  });

  it("reports a missing manifest, and does not throw", async () => {
    const r = await boot({ root: instance({}, []), env: {} });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /cannot be read/);
  });
});
