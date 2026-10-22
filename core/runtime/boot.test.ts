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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { boot } from "./boot.js";
import { checkValueOf, fingerprintOf, generateSecret, wrap } from "./fingerprint.js";

const kernel = join(import.meta.dirname, "../..");
const made: string[] = [];

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * An instance on disk. `domains` are the kernel's own packages, linked the way
 * pnpm links them; `files` is everything else, paths relative to the root.
 */
function instance(files: Record<string, string>, domains: string[] = ["relations", "acquisition"]): string {
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

/** The register's versions an instance must declare (0058): one that writes, its secret in the environment. */
const SECRET = generateSecret();
const version = (label: string, secret: string, reason = "a test") => `    - { label: ${label}, check: ${checkValueOf(secret)}, reason: "${reason}" }`;
const versions = (writes: string, ...lines: string[]) => ["fingerprints:", `  writes: ${writes}`, "  versions:", ...lines];
const ENV = { KERNEL_FINGERPRINT_T1: SECRET };

const manifest = (lines: string[], register = versions("T1", version("T1", SECRET))) => [`instance: test`, `truthsDir: truths`, ...lines, ...register, ""].join("\n");

const messages = (r: { issues: { at: string; message: string }[] }) =>
  r.issues.map((i) => `${i.at.replace(/^.*manifest\.yaml:/, "")} ${i.message}`);

describe("booting an instance", () => {
  it("refuses the template as it ships: a version is generated, never shipped (0058)", async () => {
    const r = await boot({ root: join(kernel, "template"), env: ENV });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /fingerprints no fingerprint version is declared, and one must write \(decision 0058\): run `kernel-fingerprint --label V1 --writes/);
  });

  it("boots the template once it declares a version, every contract bound to a sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "template-"));
    made.push(root);
    const template = join(kernel, "template");
    for (const entry of readdirSync(template)) if (entry !== "manifest.yaml" && entry !== ".sandbox-state.json") symlinkSync(join(template, entry), join(root, entry));
    writeFileSync(join(root, "manifest.yaml"), [readFileSync(join(template, "manifest.yaml"), "utf8"), ...versions("T1", version("T1", SECRET)), ""].join("\n"));
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual(r.domains.map((d) => d.name), ["relations", "acquisition"]);
    assert.deepEqual(
      r.registry.list().map((a) => `${a.contract}:${a.provider}`),
      [
        "target_list:sandbox-target-list",
        "people_source:sandbox-enrichment",
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
    const r = await boot({ root, env: { ...ENV, TOKEN: "x" } });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.equal(r.manifest.instance, "test");
    assert.deepEqual(r.domains.map((d) => d.name), ["relations"]);
    assert.equal(r.registry.list().length, 1);
  });

  it("reports every problem at once, not the first", async () => {
    const root = instance({
      "manifest.yaml": manifest([
        "enabledDomains: [acquisition, nowhere]",
        "providers:",
        "  - { contract: crm, adapter: ./adapters/crm.mjs, env: [MISSING] }",
        "  - { contract: sequencer, adapter: ./adapters/absent.mjs, env: [] }",
      ]),
      "adapters/crm.mjs": ADAPTER,
    });
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    const said = messages(r).join("\n");
    assert.match(said, /enabledDomains\.0 "acquisition" depends on "relations", which is not enabled/);
    assert.match(said, /enabledDomains\.1 @werunfoundry\/nowhere is not installed/);
    assert.match(said, /providers\.0\.env MISSING is declared but not set/);
    assert.match(said, /providers\.1\.adapter cannot be loaded/);
  });

  it("says one thing about a domain that is not installed, and what to do", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, acquisition]", "providers: []"]),
    }, ["relations"]);
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    assert.deepEqual(messages(r), [
      "enabledDomains.1 @werunfoundry/acquisition is not installed in this instance — add it to its package.json dependencies",
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
    const r = await boot({ root, env: ENV });
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
    const r = await boot({ root, env: ENV });
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
    const r = await boot({ root, env: ENV });
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
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    const said = messages(r).join("\n");
    assert.match(said, /providers\.0\.adapter cannot be loaded: @fixture\/esm-only is installed, but exports nothing for its main entry under the "require" or "default" condition/);
    assert.match(said, /add a "default" key beside "import"/);
    assert.doesNotMatch(said, /No "exports" main defined/);
  });

  it("loads the metrics acquisition declares, and refuses a source that reads an undeclared one", async () => {
    const source = (...metrics: string[]) => `export default () => ({ provider: "fixture", metrics: ${JSON.stringify(metrics)} });\n`;
    const good = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, acquisition]", "providers:", "  - { contract: metrics, adapter: ./adapters/m.mjs, env: [] }"]),
      "adapters/m.mjs": source("acquisition.enrolled", "acquisition.replied"),
    });
    const r = await boot({ root: good, env: ENV });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (r.ok) {
      const judged = r.domains.find((d) => d.name === "acquisition")?.experimentMetrics ?? {};
      // The guardrails are in every type, and offer_test reads replies.
      for (const [type, keys] of Object.entries(judged)) {
        assert.ok(keys.includes("acquisition.bounced") && keys.includes("acquisition.unsubscribed"), `${type} has no deliverability guardrail`);
      }
      assert.ok(judged.offer_test?.includes("acquisition.replied"), "offer_test cannot tell nobody bit from replied without booking");
      // Reply rates do not compare across channels; meetings per person enrolled do.
      assert.ok(judged.channel_test?.includes("acquisition.meetings_booked") && !judged.channel_test.includes("acquisition.replied"));
    }

    const bad = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, acquisition]", "providers:", "  - { contract: metrics, adapter: ./adapters/m.mjs, env: [] }"]),
      "adapters/m.mjs": source("acquisition.enrolled", "acquisition.revenue"),
    });
    assert.match(messages(await boot({ root: bad, env: ENV })).join("\n"), /reads "acquisition.revenue", which no enabled domain declares/);
  });

  it("refuses a metric scoped to a channel no enabled domain declares", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations, scoped]", "providers: []"]),
      "node_modules/@werunfoundry/scoped/package.json":
        '{ "name": "@werunfoundry/scoped", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
      "node_modules/@werunfoundry/scoped/domain.yaml":
        "name: scoped\nversion: 0.0.0\ndescription: x\nschema: scoped\ndependsOn: [relations]\n" +
        "channels: [email]\nmetrics:\n  - key: scoped.bounced\n    unit: people\n    channels: [carrier_pigeon]\n",
    }, ["relations"]);
    assert.match(messages(await boot({ root, env: ENV })).join("\n"), /scopes "scoped.bounced" to the channel "carrier_pigeon"/);
  });

  describe("a contract bound per channel (0015)", () => {
    /** An adapter that serves the given channels. */
    const serving = (...channels: string[]) =>
      `export default () => ({ provider: "fixture", channels: ${JSON.stringify(channels)} });\n`;
    const twoSequencers = (a: string, b: string, extra: string[] = []) =>
      instance({
        "manifest.yaml": manifest([
          "enabledDomains: [relations, acquisition]",
          "providers:",
          `  - { contract: sequencer, adapter: ./adapters/a.mjs, env: []${extra[0] ?? ""} }`,
          `  - { contract: sequencer, adapter: ./adapters/b.mjs, env: []${extra[1] ?? ""} }`,
        ]),
        "adapters/a.mjs": a,
        "adapters/b.mjs": b,
      });

    it("binds one adapter per channel, and finds each by its channel", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), serving("social_message", "social_invite")), env: ENV });
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
      const r = await boot({ root: twoSequencers(serving("email"), serving("email", "social_message")), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.1\.channels the channel "email" of contract "sequencer" is already taken by providers\.0; one adapter per channel/);
    });

    it("lets a binding narrow an adapter to some of its channels, which resolves the overlap", async () => {
      const r = await boot({
        root: twoSequencers(serving("email"), serving("email", "social_message"), ["", ", channels: [social_message]"]),
        env: ENV,
      });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
    });

    it("refuses a binding that assigns a channel the adapter does not serve", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), serving("social_message"), ["", ", channels: [social_invite]"]), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /"social_invite" is not a channel this adapter serves/);
    });

    it("refuses a contract bound twice where a binding takes no channel", async () => {
      const r = await boot({ root: twoSequencers(serving("email"), ADAPTER), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /bound more than once, so each binding takes channels or finds keys in sequence, and this one does neither/);
    });

    it("refuses a channel no enabled domain declares, whoever names it", async () => {
      const declaredByAdapter = await boot({ root: twoSequencers(serving("email"), serving("carrier_pigeon")), env: ENV });
      assert.match(messages(declaredByAdapter).join("\n"), /no enabled domain declares the channel "carrier_pigeon"/);
      const namedByManifest = await boot({ root: twoSequencers(serving("email"), serving("social_message"), ["", ", channels: [carrier_pigeon]"]), env: ENV });
      assert.match(messages(namedByManifest).join("\n"), /no enabled domain declares the channel "carrier_pigeon"/);
    });
  });

  describe("a contract bound in sequence, by what it finds (0030)", () => {
    /** An adapter that finds the given key kinds. */
    const finding = (provider: string, ...kinds: string[]) =>
      `export default () => ({ provider: ${JSON.stringify(provider)}, finds: ${JSON.stringify(kinds)} });\n`;
    const twoSources = (a: string, b: string, extra: string[] = []) =>
      instance({
        "manifest.yaml": manifest([
          "enabledDomains: [relations]",
          "providers:",
          `  - { contract: enrichment, adapter: ./adapters/a.mjs, env: []${extra[0] ?? ""} }`,
          `  - { contract: enrichment, adapter: ./adapters/b.mjs, env: []${extra[1] ?? ""} }`,
        ]),
        "adapters/a.mjs": a,
        "adapters/b.mjs": b,
      }, ["relations"]);

    it("binds two sources, and answers them in the manifest's order with what each finds", async () => {
      const r = await boot({ root: twoSources(finding("first", "email"), finding("second", "email", "social_profile_handle")), env: ENV });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
      if (!r.ok) return;
      assert.deepEqual(
        r.registry.sequence("enrichment").map((s) => `${s.provider}:${s.finds.join("+")}`),
        ["first:email", "second:email+social_profile_handle"],
      );
      assert.throws(() => r.registry.get("enrichment"), /bound in sequence \(first → second\)/);
    });

    it("follows the manifest: the same two sources, listed the other way, run the other way", async () => {
      const r = await boot({ root: twoSources(finding("second", "email"), finding("first", "email")), env: ENV });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
      if (!r.ok) return;
      assert.deepEqual(r.registry.sequence("enrichment").map((s) => s.provider), ["second", "first"]);
    });

    it("lets a binding narrow a source to some of the kinds it finds", async () => {
      const r = await boot({
        root: twoSources(finding("first", "email", "social_profile_handle"), finding("second", "email"), [", finds: [social_profile_handle]"]),
        env: ENV,
      });
      assert.equal(r.ok, true, JSON.stringify(r.issues));
      if (!r.ok) return;
      assert.deepEqual(r.registry.sequence("enrichment")[0]?.finds, ["social_profile_handle"]);
    });

    it("refuses a binding that asks a source for a kind it does not find", async () => {
      const r = await boot({ root: twoSources(finding("first", "email"), finding("second", "email"), [", finds: [social_profile_id]"]), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.0\.finds\.0 "social_profile_id" is not a key this adapter finds \(it finds email\)/);
    });

    it("refuses a kind no enabled domain declares, whoever names it", async () => {
      const declaredByAdapter = await boot({ root: twoSources(finding("first", "email"), finding("second", "fax")), env: ENV });
      assert.match(messages(declaredByAdapter).join("\n"), /providers\.1\.finds no enabled domain declares the identity key "fax"/);
      const namedByManifest = await boot({ root: twoSources(finding("first", "email"), finding("second", "email"), ["", ", finds: [fax]"]), env: ENV });
      assert.match(messages(namedByManifest).join("\n"), /providers\.1\.finds\.0 no enabled domain declares the identity key "fax"/);
    });

    it("refuses a sequence where one binding finds nothing", async () => {
      const r = await boot({ root: twoSources(finding("first", "email"), ADAPTER), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.1 contract "enrichment" is bound in sequence, so each binding finds keys, and this one finds none/);
    });

    it("refuses a contract bound per channel by one binding and in sequence by another", async () => {
      const r = await boot({
        root: twoSources(`export default () => ({ provider: "by-channel", channels: ["email"] });\n`, finding("by-kind", "email")),
        env: ENV,
      });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.1 contract "enrichment" is bound per channel by another binding, and this one finds keys in sequence; never both ways at once/);
    });

    it("refuses a binding that names both channels and kinds", async () => {
      const r = await boot({ root: twoSources(finding("first", "email"), finding("second", "email"), [", channels: [email], finds: [email]"]), env: ENV });
      assert.equal(r.ok, false);
      assert.match(messages(r).join("\n"), /providers\.0 a binding takes channels or finds keys in sequence, never both/);
    });
  });

  it("carries the identity vocabulary the installed domains declare, and the instance's networks", async () => {
    const root = instance({
      "manifest.yaml": manifest(["enabledDomains: [relations]", "providers: []", "networks: [net_a]"]),
    }, ["relations"]);
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual([...r.identity.kinds.keys()].sort(), ["domain", "email", "phone", "social_company_id", "social_profile_handle", "social_profile_id"]);
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
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /"email" is declared by both "relations" and "twin"; a key two domains need belongs one layer down/);
  });

  it("refuses a network that is not an identifier", async () => {
    const root = instance({ "manifest.yaml": manifest(["enabledDomains: [relations]", "providers: []", "networks: [Net-A]"]) }, ["relations"]);
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /networks\.0/);
  });

  it("reports a manifest that is not YAML, and does not throw", async () => {
    const root = instance({ "manifest.yaml": "instance: [unclosed\n" }, []);
    const r = await boot({ root, env: ENV });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /is not valid YAML/);
  });

  it("reports a missing manifest, and does not throw", async () => {
    const r = await boot({ root: instance({}, []), env: ENV });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /cannot be read/);
  });
});

describe("the register's versions (0058, 0063)", () => {
  const OLD = generateSecret();
  const at = (lines: string[], env: Record<string, string>) =>
    boot({ root: instance({ "manifest.yaml": manifest(["enabledDomains: [relations]", "providers: []"], lines) }, ["relations"]), env });

  it("hands erasure the version that writes, fingerprinting as the one function does, and no secret", async () => {
    const r = await at(versions("T1", version("T1", SECRET)), ENV);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    const key = { kind: "email", value: " Ada@Example.com " };
    assert.deepEqual(r.fingerprints.fingerprint(key), { fingerprint: fingerprintOf(SECRET, key, r.identity), chain: ["T1"] });
    assert.deepEqual(r.fingerprints.missing, []);
    assert.doesNotMatch(JSON.stringify(r.fingerprints), new RegExp(SECRET));
  });

  it("hands the one reader every version it holds, so an entry under an older chain is recognised (0055, 0058 §3)", async () => {
    const r = await at(versions("T1", version("T0", OLD), version("T1", SECRET)), { ...ENV, KERNEL_FINGERPRINT_T0: OLD });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    const key = { kind: "email", value: "ada@example.com" };
    assert.equal(r.fingerprints.under(["T0"], key), fingerprintOf(OLD, key, r.identity));
    assert.equal(r.fingerprints.under(["T0", "T1"], key), wrap(SECRET, fingerprintOf(OLD, key, r.identity)));
    assert.doesNotMatch(JSON.stringify(r.fingerprints), new RegExp(OLD));
  });

  it("refuses the version that writes when its variable is not set, for every process (0063)", async () => {
    const r = await at(versions("T1", version("T1", SECRET)), {});
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /fingerprints\.versions\.0 KERNEL_FINGERPRINT_T1 is not set, and version T1 writes: an erasure could not keep an objection \(decision 0063\)/);
  });

  it("boots without an older version's secret, warns, and says it is missing (0063)", async () => {
    const r = await at(versions("T1", version("T0", OLD), version("T1", SECRET)), ENV);
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual(r.fingerprints.missing, ["T0"]);
    assert.deepEqual(r.issues.map((i) => [i.severity, i.message]), [
      ["warning", "KERNEL_FINGERPRINT_T0 is not set: the entries under version T0 protect nobody, and contact stops at the register until it is restored; erasure goes on (decision 0063)"],
    ]);
  });

  it("refuses a secret that is not 64 lower-case hexadecimal characters, an older version's too (0058)", async () => {
    const r = await at(versions("T1", version("T0", OLD), version("T1", SECRET)), { ...ENV, KERNEL_FINGERPRINT_T0: OLD.toUpperCase() });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /fingerprints\.versions\.0 KERNEL_FINGERPRINT_T0 is not 64 lower-case hexadecimal characters/);
  });

  it("refuses a secret that does not reproduce its check value, an older version's too: it would fail open in silence (0058)", async () => {
    const r = await at(versions("T1", version("T0", OLD), version("T1", SECRET)), { ...ENV, KERNEL_FINGERPRINT_T0: generateSecret() });
    assert.equal(r.ok, false);
    assert.match(messages(r).join("\n"), /fingerprints\.versions\.0 KERNEL_FINGERPRINT_T0 does not reproduce version T0's check value/);
  });

  it("refuses a version that writes and is not declared, a label declared twice, and a version without its reason (0058)", async () => {
    const undeclared = await at(versions("T2", version("T1", SECRET)), ENV);
    assert.match(messages(undeclared).join("\n"), /fingerprints\.writes "T2" writes, and is not declared under versions/);
    const twice = await at(versions("T1", version("T1", SECRET), version("T1", OLD)), ENV);
    assert.match(messages(twice).join("\n"), /fingerprints\.versions\.1\.label "T1" is declared twice; a label is never reused/);
    const reasonless = await at(versions("T1", version("T1", SECRET, " ")), ENV);
    assert.match(messages(reasonless).join("\n"), /say why this version was added \(decision 0058\)/);
    for (const r of [undeclared, twice, reasonless]) assert.equal(r.ok, false);
  });
});
