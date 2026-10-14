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
  it("boots the template as it ships", async () => {
    const r = await boot({ root: join(kernel, "template"), env: { EXAMPLE_CRM_TOKEN: "unused" } });
    assert.equal(r.ok, true, JSON.stringify(r.issues));
    if (!r.ok) return;
    assert.deepEqual(r.domains.map((d) => d.name), ["relations", "gtm"]);
    assert.equal(r.registry.require("crm").provider, "example-crm");
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
    assert.match(messages(r).join("\n"), /does not export \.\/domain\.yaml/);
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
