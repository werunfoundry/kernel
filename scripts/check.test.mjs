/**
 * Tests for the doctrine checks.
 *
 * These exist because the checks are the only thing enforcing the doctrine,
 * and until now they were the one component nothing verified. Each was
 * validated by hand, by planting a violation and watching it fail — four
 * times, with the fixtures deleted each time. This file is that work made
 * permanent.
 *
 * Every test plants a real violation in a real git repository and asserts
 * which rule fires. A test that only asserts "exit code 1" would pass for the
 * wrong reason the day a regex catches something adjacent.
 *
 *   node --test scripts/
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "check.mjs");

/**
 * The fixtures below are assembled from parts, and that is not squeamishness:
 * a file containing a literal `sk-…` is a file the checks must refuse, test
 * suite or not. Exempting this file would put a hole in the one check whose
 * failure is unrecoverable. Splitting the string keeps the repository free of
 * anything that reads as a credential, while the value the subprocess writes
 * to disk is whole and exercises the real pattern.
 */
const FAKE_KEY = `sk${"-"}abcdefghijklmnopqrstuvwxyz0123`;
const FAKE_URL = [
  "postgresql://u",
  "hunter2hunter2@db.example.com/x",
].join(":");
const made = [];

/** A repository that passes, so that a failing test fails for its own reason. */
const BASELINE = {
  "package.json": '{\n  "name": "t"\n}\n',
  "core/db/schema.ts":
    'import { pgSchema } from "drizzle-orm/pg-core";\nexport const core = pgSchema("core");\n',
  "domains/alpha/domain.yaml":
    "name: alpha\nversion: 0.0.0\ndescription: x\nschema: alpha\ndependsOn: []\n",
  "core/package.json": '{ "name": "@werunfoundry/core", "exports": {}, "publishConfig": { "exports": {} } }\n',
  "domains/alpha/package.json":
    '{ "name": "@werunfoundry/alpha", "exports": { "./domain.yaml": "./domain.yaml" }, "publishConfig": { "exports": { "./domain.yaml": "./domain.yaml" } } }\n',
  "domains/beta/package.json":
    '{ "name": "@werunfoundry/beta", "exports": { "./domain.yaml": "./domain.yaml" }, "publishConfig": { "exports": { "./domain.yaml": "./domain.yaml" } } }\n',
  "domains/alpha/db/schema.ts":
    'import { pgSchema } from "drizzle-orm/pg-core";\nexport const alpha = pgSchema("alpha");\n',
  "domains/beta/domain.yaml":
    "name: beta\nversion: 0.0.0\ndescription: x\nschema: beta\ndependsOn:\n  - alpha\n",
  "domains/beta/db/schema.ts":
    'import { pgSchema } from "drizzle-orm/pg-core";\nexport const beta = pgSchema("beta");\n',
};

function repo(extra = {}, { git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctrine-"));
  made.push(dir);
  for (const [path, body] of Object.entries({ ...BASELINE, ...extra })) {
    if (body === undefined) continue; // removes a baseline file
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  }
  return dir;
}

function run(dir, args = []) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Asserts the run failed *for the stated rule*, naming the file. */
function refuses(dir, rule, needle, args = []) {
  const { code, out } = run(dir, args);
  assert.equal(code, 1, `expected a refusal, got ${code}:\n${out}`);
  assert.match(out, new RegExp(`rule ${rule}\\b`), `expected rule ${rule}:\n${out}`);
  assert.match(out, new RegExp(needle), `expected a mention of ${needle}:\n${out}`);
}

function accepts(dir, args = []) {
  const { code, out } = run(dir, args);
  assert.equal(code, 0, `expected acceptance:\n${out}`);
}

after(() => {
  for (const dir of made) {
    try {
      execFileSync("rm", ["-rf", dir]);
    } catch {
      /* a leftover temp directory is not worth failing a test run */
    }
  }
});

describe("the baseline", () => {
  it("passes, so every other failure below is the planted one", () => {
    accepts(repo());
  });
});

describe("rule 7 — nothing published that cannot be unpublished", () => {
  it("refuses a committed .env", () => {
    refuses(repo({ ".env": "TOKEN=x\n" }), 7, "\\.env");
  });

  it("allows .env.example", () => {
    accepts(repo({ ".env.example": "DATABASE_URL=\n" }));
  });

  it("refuses an API key", () => {
    refuses(repo({ "core/x.ts": `const k = "${FAKE_KEY}";\n` }), 7, "sk-");
  });

  it("refuses a connection string carrying a password", () => {
    refuses(
      repo({ "core/x.ts": `const u = "${FAKE_URL}";\n` }),
      7,
      "connection string",
    );
  });

  it("refuses a real-looking address in a fixture", () => {
    refuses(repo({ "core/fixtures/people.ts": 'export const e = "ada@realcompany.co";\n' }), 7, "real-looking");
  });

  it("allows an invented address in a fixture", () => {
    accepts(repo({ "core/fixtures/people.ts": 'export const e = "ada@example.com";\n' }));
  });

  it("refuses a real profile URL in a fixture", () => {
    refuses(repo({ "core/fixtures/p.ts": '// https://linkedin.com/in/someone\n' }), 7, "profile");
  });
});

describe("rule 7 — every file is text the checks can read", () => {
  /**
   * A tarball of a working tree, reduced to what matters: a header naming the
   * member, NUL-padded to 512 bytes, then the member. Every byte is ASCII, so
   * it decodes as UTF-8 — only the NULs give it away.
   */
  const tar = (name, body) => {
    const out = Buffer.alloc(1024);
    out.write(name, 0, "ascii");
    out.write(body, 512, "ascii");
    return out;
  };

  it("refuses a compressed archive, even one .gitignore lists and git add -f forced in", () => {
    const dir = repo({
      ".gitignore": "*.tgz\n",
      "snapshot.tgz": gzipSync(tar(".env", "TOKEN=x\n")),
    });
    execFileSync("git", ["add", "-f", "snapshot.tgz"], { cwd: dir });
    refuses(dir, 7, "snapshot\\.tgz");
  });

  it("refuses an uncompressed archive, which is valid UTF-8", () => {
    const archive = tar(".env", "TOKEN=x\n");
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(archive));
    refuses(repo({ "snapshot.tar": archive }), 7, "NUL byte");
  });

  it("refuses bytes that are not UTF-8, whatever the file is named", () => {
    refuses(repo({ "core/notes.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }), 7, "not valid UTF-8");
  });

  it("allows UTF-8 beyond ASCII, which every decision here uses", () => {
    accepts(repo({ "core/x.ts": "// a dash — an accent é, a mark ✓\nexport const x = 1;\n" }));
  });
});

describe("rule 1 — a provider is named only inside its adapter", () => {
  it("refuses a provider named in the core", () => {
    refuses(repo({ "core/x.ts": 'export const p = "hubspot";\n' }), 1, "hubspot");
  });

  it("refuses a provider named in a domain's tables", () => {
    refuses(repo({ "domains/alpha/db/extra.ts": 'const p = "salesforce";\n' }), 1, "salesforce");
  });

  it("allows one inside an adapter, which is the whole point of adapters", () => {
    accepts(repo({ "adapters/vendor/index.ts": 'export const p = "salesforce";\n' }));
  });

  it("allows one in the template's adapters, which an instance inherits", () => {
    accepts(repo({ "template/adapters/crm.ts": 'export const p = "salesforce";\n' }));
  });

  it("allows one in prose explaining why it must not appear", () => {
    accepts(repo({ "core/x.ts": "// never write hubspot here\nexport const x = 1;\n" }));
  });

  it("refuses one in a decision, where a provider is most likely to be named", () => {
    refuses(repo({ "decisions/0099-x.md": "# 0099 — x\n\nWe chose lemlist because it was there.\n" }), 1, "lemlist");
  });

  it("refuses a social network named outside an adapter, even as an identity key", () => {
    refuses(repo({ "domains/alpha/domain.yaml": BASELINE["domains/alpha/domain.yaml"] + "identityKeys:\n  - kind: linkedin_profile_id\n" }), 1, "linkedin");
  });

  it("refuses one inside an identifier, where an underscore is not a boundary for \\b", () => {
    refuses(repo({ "core/x.ts": "export const hubspot_id = 1;\n" }), 1, "hubspot");
  });

  it("does not refuse a word that merely contains one", () => {
    accepts(repo({ "core/x.ts": "export const clayey = 1; // a soil, not a provider\nexport const apollonian = 2;\n" }));
  });

  it("refuses one in the README", () => {
    refuses(repo({ "README.md": "# kernel\n\nWorks well with pipedrive.\n" }), 1, "pipedrive");
  });

  it("refuses one in the template outside its adapters", () => {
    refuses(repo({ "template/README.md": "Bind your attio workspace here.\n" }), 1, "attio");
  });

  it("refuses one in a Markdown heading or list item, which are not comments", () => {
    refuses(repo({ "decisions/0099-x.md": "# 0099 — Why smartlead\n" }), 1, "smartlead");
    refuses(repo({ "decisions/0099-x.md": "* hubspot was considered\n" }), 1, "hubspot");
  });

  it("allows a YAML comment explaining why, as it allows a code comment", () => {
    accepts(repo({ "template/manifest.yaml": "# not apollo: it is a target list, bound elsewhere\ninstance: x\n" }));
  });

  it("exempts the two files that hold the list, by exact path and nothing else", () => {
    const named = 'export const p = "hubspot";\n';
    accepts(repo({ "scripts/check.mjs": named, "scripts/check.test.mjs": named }));
    for (const near of [
      "scripts/check2.mjs",
      "scripts/check.mjs.md",
      "scripts/check-instance.mjs",
      "tools/scripts/check.mjs",
      "scripts/sub/check.mjs",
      "Scripts/check.mjs",
    ]) {
      refuses(repo({ [near]: named }), 1, "hubspot");
    }
  });
});

describe("rule 2 — dependencies point down, never sideways", () => {
  it("refuses an import from a domain that was not declared", () => {
    refuses(
      repo({
        "domains/alpha/db/schema.ts":
          'import { pgSchema } from "drizzle-orm/pg-core";\n' +
          'import { beta } from "@werunfoundry/beta/db/schema";\n' +
          'export const alpha = pgSchema("alpha");\n',
      }),
      2,
      "does not declare",
    );
  });

  it("refuses a foreign key pointing at an undeclared domain", () => {
    refuses(
      repo({
        "domains/alpha/db/schema.ts":
          'import { pgSchema } from "drizzle-orm/pg-core";\n' +
          'import { thing } from "@werunfoundry/beta/db/schema";\n' +
          'export const alpha = pgSchema("alpha");\n' +
          "export const t = { id: x.references(() => thing.id) };\n",
      }),
      2,
      "foreign key",
    );
  });

  it("allows a declared dependency", () => {
    accepts(
      repo({
        "domains/beta/db/schema.ts":
          'import { pgSchema } from "drizzle-orm/pg-core";\n' +
          'import { alpha } from "@werunfoundry/alpha/db/schema";\n' +
          'export const beta = pgSchema("beta");\n',
      }),
    );
  });

  it("refuses the core depending on anything", () => {
    refuses(
      repo({
        "core/db/schema.ts":
          'import { pgSchema } from "drizzle-orm/pg-core";\n' +
          'import { alpha } from "@werunfoundry/alpha/db/schema";\n' +
          'export const core = pgSchema("core");\n',
      }),
      2,
      "bottom layer",
    );
  });

  it("refuses a dependency on a domain that does not exist", () => {
    refuses(
      repo({
        "domains/beta/domain.yaml":
          "name: beta\nversion: 0.0.0\ndescription: x\nschema: beta\ndependsOn:\n  - nowhere\n",
      }),
      2,
      "not a domain here",
    );
  });

  it("refuses a schema declared where the dependency check cannot see it", () => {
    refuses(
      repo({
        "domains/alpha/extra/schema.ts":
          'import { pgSchema } from "drizzle-orm/pg-core";\nexport const s = pgSchema("extra");\n',
      }),
      2,
      "invisible",
    );
  });

  it("refuses a domain folder with no domain.yaml", () => {
    refuses(repo({ "domains/gamma/index.ts": "export const x = 1;\n" }), 2, "no domain.yaml");
  });

  it("refuses a domain nested inside a domain", () => {
    refuses(repo({ "domains/alpha/domains/sub/index.ts": "export const x = 1;\n" }), 2, "layers are flat");
  });
});

describe("rule 6 — an adapter sees contracts, and nothing else of the engine", () => {
  /** One adapter file holding exactly the line under test, so no other rule can answer for it. */
  const adapter = (line, path = "adapters/vendor/index.ts") => repo({ [path]: `${line}\nexport const x = 1;\n` });

  it("allows the contracts of two sibling domains, the core's contract types and identity", () => {
    accepts(
      repo({
        "adapters/vendor/index.ts": [
          'import type { A } from "@werunfoundry/alpha/contracts/a";',
          'import type { B } from "@werunfoundry/beta/contracts";',
          'import type { CallResult } from "@werunfoundry/core/contracts/types";',
          'import type { Identity } from "@werunfoundry/core/identity";',
          'import { request } from "node:https";',
          'import { client } from "./client.js";',
          'import sdk from "vendor-sdk";',
          "export const x = 1;",
          "",
        ].join("\n"),
      }),
    );
  });

  it("refuses a schema", () => {
    refuses(adapter('import { t } from "@werunfoundry/alpha/db/schema";'), 6, "imports @werunfoundry/alpha/db/schema");
  });

  it("refuses the runtime", () => {
    refuses(adapter('import { enrol } from "@werunfoundry/beta/runtime/enrol";'), 6, "imports @werunfoundry/beta/runtime/enrol");
  });

  it("refuses the core beyond its contracts and identity", () => {
    refuses(adapter('import type { M } from "@werunfoundry/core/manifest/types";'), 6, "imports @werunfoundry/core/manifest/types");
  });

  it("refuses another adapter", () => {
    refuses(adapter('import other from "@werunfoundry/adapters/other";'), 6, "imports @werunfoundry/adapters/other");
  });

  it("refuses a re-export, which the layer check does not read", () => {
    refuses(adapter('export { t } from "@werunfoundry/alpha/db/schema";'), 6, "imports @werunfoundry/alpha/db/schema");
  });

  it("refuses a bare import for its side effects", () => {
    refuses(adapter('import "@werunfoundry/alpha/db/schema";'), 6, "imports @werunfoundry/alpha/db/schema");
  });

  it("refuses require and a literal dynamic import", () => {
    refuses(adapter('const s = require("@werunfoundry/alpha/db/schema");'), 6, "imports @werunfoundry/alpha/db/schema");
    refuses(adapter('const s = await import("@werunfoundry/alpha/db/schema");'), 6, "imports @werunfoundry/alpha/db/schema");
  });

  it("refuses a dynamic import it cannot read", () => {
    refuses(adapter("const s = await import(name);"), 6, "cannot read");
  });

  it("refuses a relative import out of its own folder", () => {
    refuses(adapter('import { t } from "../../domains/alpha/db/schema.ts";'), 6, "outside adapters/vendor/");
    refuses(adapter('import { y } from "../other/index.ts";'), 6, "outside adapters/vendor/");
  });

  it("refuses a database client, which reaches the database without importing anything of ours", () => {
    refuses(adapter('import pg from "pg";'), 6, "imports pg");
    refuses(adapter('import { sql } from "drizzle-orm";'), 6, "imports drizzle-orm");
  });

  it("holds in the template's adapters, which an instance inherits", () => {
    refuses(adapter('import { t } from "@werunfoundry/alpha/db/schema";', "template/adapters/x.ts"), 6, "imports @werunfoundry/alpha/db/schema");
    refuses(adapter('import { t } from "../../core/db/schema.ts";', "template/adapters/x.ts"), 6, "outside template/adapters/");
    accepts(adapter('import { load } from "./store.ts";', "template/adapters/x.ts"));
  });

  it("ignores prose that names a forbidden import", () => {
    accepts(adapter('// never: import { t } from "@werunfoundry/alpha/db/schema";'));
  });
});

describe("rule 6 — a rule can only hold where it can see", () => {
  it("refuses an adapter in the core, which would switch rule 1 off there", () => {
    refuses(repo({ "core/adapters/crm.ts": "export const x = 1;\n" }), 6, "adapter lives in");
  });

  it("refuses an adapter inside a domain, where a sibling domain's contracts are out of sight", () => {
    refuses(repo({ "domains/alpha/adapters/vendor/index.ts": "export const x = 1;\n" }), 6, "adapter lives in");
  });

  it("refuses code at the root of adapters/, which belongs to no provider", () => {
    refuses(repo({ "adapters/crm.ts": "export const x = 1;\n" }), 6, "adapter lives in");
  });

  it("refuses an adapters package that publishes other paths than it exports", () => {
    refuses(
      repo({
        "adapters/package.json":
          '{ "name": "@werunfoundry/adapters", "exports": { "./*": "./*/index.ts" }, "publishConfig": { "exports": {} } }\n',
      }),
      6,
      "exports and publishConfig.exports list different paths",
    );
  });

  it("allows the adapters package's own files at that root", () => {
    accepts(repo({ "adapters/package.json": '{ "name": "x" }\n', "adapters/tsconfig.json": "{}\n" }));
  });

  it("refuses a domain that does not export its domain.yaml, which no instance could boot", () => {
    refuses(
      repo({
        "domains/alpha/package.json":
          '{ "name": "@werunfoundry/alpha", "exports": {}, "publishConfig": { "exports": {} } }\n',
      }),
      6,
      "does not export",
    );
  });

  it("refuses a domain whose package an instance would look for under another name", () => {
    refuses(
      repo({
        "domains/alpha/package.json":
          '{ "name": "@werunfoundry/a", "exports": { "./domain.yaml": "./domain.yaml" }, ' +
          '"publishConfig": { "exports": { "./domain.yaml": "./domain.yaml" } } }\n',
      }),
      6,
      "looks for this domain",
    );
  });

  it("refuses an export the workspace has and the published package would not", () => {
    refuses(
      repo({
        "core/package.json":
          '{ "name": "@werunfoundry/core", "exports": { "./x": "./x.ts" }, "publishConfig": { "exports": {} } }\n',
      }),
      6,
      "list different paths",
    );
  });

  it("refuses publishing TypeScript source", () => {
    refuses(
      repo({
        "core/package.json":
          '{ "name": "@werunfoundry/core", "exports": { "./x": "./x.ts" }, ' +
          '"publishConfig": { "exports": { "./x": { "types": "./dist/x.d.ts", "default": "./x.ts" } } } }\n',
      }),
      6,
      "as TypeScript source",
    );
  });

  it("refuses a command the workspace has and the published package would run as TypeScript", () => {
    refuses(
      repo({
        "core/package.json":
          '{ "name": "@werunfoundry/core", "exports": {}, "bin": { "x": "./bin/x.ts" }, ' +
          '"publishConfig": { "exports": {}, "bin": { "x": "./bin/x.ts" } } }\n',
      }),
      6,
      "as TypeScript source",
    );
  });

  it("refuses a command missing from the published package", () => {
    refuses(
      repo({
        "core/package.json":
          '{ "name": "@werunfoundry/core", "exports": {}, "bin": { "x": "./x.mjs", "y": "./bin/y.ts" }, ' +
          '"publishConfig": { "exports": {}, "bin": { "x": "./x.mjs" } } }\n',
      }),
      6,
      "different commands",
    );
  });

  it("refuses a domain with no package.json", () => {
    refuses(repo({ "domains/alpha/package.json": undefined }), 6, "without a readable package.json");
  });

  it("refuses JSON no machine can read", () => {
    refuses(repo({ "core/tsconfig.json": '{ "a": 1 }\\n' }), 6, "not valid JSON");
  });
});

describe("rule 6 — a decision's cross-references hold", () => {
  // Each fixture holds one way to break one rule, and nothing the other
  // rule would refuse: no line citation where a pointer is missing, and
  // every pointer in place where a line is cited.
  const first = "# 0001 — First\n\nIt says one thing.\n\n## Decided\n\nThat.\n";
  const pointed = "# 0001 — First\n\n> Completed by [0002](0002-second.md): more.\n\nIt says one thing.\n\n## Decided\n\nThat.\n";
  const second = (intro) => `# 0002 — Second\n\n${intro}\n\n## Decided\n\nMore.\n`;
  const decisions = (one, two) => ({ "decisions/0001-first.md": one, "decisions/0002-second.md": two });

  it("refuses a decision cited by line", () => {
    refuses(repo(decisions(first, second("It reads 0001 (0001:5)."))), 6, "cites a decision by line, 0001:5");
  });

  it("refuses a line citation in a pointer too", () => {
    const one = "# 0001 — First\n\n> Superseded in part by [0002](0002-second.md): its line 0001:7.\n\nIt.\n\n## Decided\n\nThat.\n";
    refuses(repo(decisions(one, second("It reads 0001."))), 6, "decisions/0001-first\\.md:3");
  });

  it("allows a decision cited by section, and code cited by line", () => {
    accepts(repo(decisions(first, second("It reads 0001, *Decided*, and `erase.ts:60` on `main` at `abc1234`."))));
  });

  it("refuses a decision that completes another carrying no pointer back", () => {
    refuses(repo(decisions(first, second("Completes [0001](0001-first.md), which said one thing."))), 6, "completes, supersedes or reverses 0001");
  });

  it("refuses the same for one that supersedes or reverses it", () => {
    refuses(repo(decisions(first, second("Supersedes in part [0001](0001-first.md)."))), 6, "reverses 0001");
    refuses(repo(decisions(first, second("Reverses the answer 0001 gave."))), 6, "reverses 0001");
  });

  it("allows it once the other decision points back, under its title", () => {
    accepts(repo(decisions(pointed, second("Completes [0001](0001-first.md), which said one thing."))));
  });

  it("does not take a mention in the other decision's body for a pointer", () => {
    const body = "# 0001 — First\n\nIt says one thing.\n\n## Decided\n\n> Completed by [0002](0002-second.md): not under the title.\n";
    refuses(repo(decisions(body, second("Completes [0001](0001-first.md)."))), 6, "carries no pointer to 0002");
  });

  it("does not ask a pointer of a decision the introduction only rests on", () => {
    accepts(repo(decisions(first, second("Completes nothing here, and rests on [0001](0001-first.md)."))));
  });

  it("reads the verb sentence by sentence", () => {
    accepts(repo(decisions(first, second("Completes nothing. It was found while reading 0001."))));
  });
});

describe("--staged", () => {
  const stage = (dir, paths) => execFileSync("git", ["add", ...paths], { cwd: dir });

  it("does not report a missing domain.yaml when the commit simply does not touch one", () => {
    const dir = repo({ "domains/alpha/db/schema.ts": 'import { pgSchema } from "drizzle-orm/pg-core";\nexport const alpha = pgSchema("alpha");\n// edited\n' });
    stage(dir, ["domains/alpha/db/schema.ts"]);
    accepts(dir, ["--staged"]);
  });

  it("still catches a secret in what is being committed", () => {
    const dir = repo({ "core/leak.ts": `const k = "${FAKE_KEY}";\n` });
    stage(dir, ["core/leak.ts"]);
    refuses(dir, 7, "sk-", ["--staged"]);
  });

  it("sees a problem in a file the commit does not touch at all", () => {
    // The point of the two listings: a half-created domain elsewhere in the
    // tree is still a problem, even when this commit is about something else.
    const dir = repo({ "domains/gamma/index.ts": "export const x = 1;\n" });
    stage(dir, ["domains/alpha/db/schema.ts"]);
    refuses(dir, 2, "no domain.yaml", ["--staged"]);
  });

  it("still catches an archive forced past .gitignore", () => {
    const dir = repo({ ".gitignore": "*.tgz\n", "snapshot.tgz": gzipSync("TOKEN=x\n") });
    stage(dir, ["-f", "snapshot.tgz"]);
    refuses(dir, 7, "snapshot\\.tgz", ["--staged"]);
  });

  it("still catches a decision cited by line in what is being committed", () => {
    const dir = repo({ "decisions/0001-first.md": "# 0001 — First\n\nIt reads 0000:4.\n\n## Decided\n\nThat.\n" });
    stage(dir, ["decisions/0001-first.md"]);
    refuses(dir, 6, "cites a decision by line", ["--staged"]);
  });

  it("reads the pointer back in a decision the commit does not touch", () => {
    const dir = repo({
      "decisions/0001-first.md": "# 0001 — First\n\nIt.\n\n## Decided\n\nThat.\n",
      "decisions/0002-second.md": "# 0002 — Second\n\nCompletes [0001](0001-first.md).\n\n## Decided\n\nMore.\n",
    });
    stage(dir, ["decisions/0002-second.md"]);
    refuses(dir, 6, "carries no pointer to 0002", ["--staged"]);
  });

  it("still catches a structural violation from a partial commit", () => {
    const dir = repo({ "core/adapters/a.ts": "export const x = 1;\n" });
    stage(dir, ["core/adapters/a.ts"]);
    refuses(dir, 6, "adapter lives in", ["--staged"]);
  });
});

describe("--message", () => {
  const message = (body) => {
    const dir = repo();
    writeFileSync(join(dir, "MSG"), body);
    return dir;
  };

  it("refuses a link to a private session", () => {
    const dir = message("fix: x\n\nClaude-Session: https://claude.ai/code/session_01ABCDEFGHIJKLMNOP\n");
    const { code, out } = run(dir, ["--message", "MSG"]);
    assert.equal(code, 1, out);
    assert.match(out, /private assistant session/);
  });

  it("refuses a secret pasted into a message", () => {
    const dir = message(`fix: x\n\nDATABASE_URL=${FAKE_URL}\n`);
    const { code, out } = run(dir, ["--message", "MSG"]);
    assert.equal(code, 1, out);
    assert.match(out, /connection string/);
  });

  it("ignores git's own comment lines, which are never committed", () => {
    const dir = message("fix: x\n\n# https://claude.ai/code/session_01ABCDEFGHIJKLMNOP\n");
    assert.equal(run(dir, ["--message", "MSG"]).code, 0);
  });

  it("accepts an ordinary message", () => {
    const dir = message("fix: parse every JSON in the checks\n\nNothing local caught it.\n");
    assert.equal(run(dir, ["--message", "MSG"]).code, 0);
  });
});

describe("when it cannot do its job", () => {
  it("says so in one line and exits 2, rather than throwing a stack trace", () => {
    const { code, out } = run(repo({}, { git: false }));
    assert.equal(code, 2, out);
    assert.match(out, /cannot list the files to check/);
    assert.ok(!out.includes("at ModuleJob"), `expected no stack trace:\n${out}`);
    assert.ok(out.trim().split("\n").length <= 2, `expected one line:\n${out}`);
  });
});
