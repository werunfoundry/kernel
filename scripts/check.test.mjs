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
  "domains/alpha/package.json":
    '{ "name": "@werunfoundry/alpha", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
  "domains/beta/package.json":
    '{ "name": "@werunfoundry/beta", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
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

describe("rule 1 — a provider is named only inside its adapter", () => {
  it("refuses a provider named in the core", () => {
    refuses(repo({ "core/x.ts": 'export const p = "hubspot";\n' }), 1, "hubspot");
  });

  it("refuses a provider named in a domain's tables", () => {
    refuses(repo({ "domains/alpha/db/extra.ts": 'const p = "salesforce";\n' }), 1, "salesforce");
  });

  it("allows one inside an adapter, which is the whole point of adapters", () => {
    accepts(repo({ "domains/alpha/adapters/crm.ts": 'export const p = "salesforce";\n' }));
  });

  it("allows one in the template's adapters, which an instance inherits", () => {
    accepts(repo({ "template/adapters/crm.ts": 'export const p = "salesforce";\n' }));
  });

  it("allows one in prose explaining why it must not appear", () => {
    accepts(repo({ "core/x.ts": "// never write hubspot here\nexport const x = 1;\n" }));
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

describe("rule 6 — a rule can only hold where it can see", () => {
  it("refuses an adapter in the core, which would switch rule 1 off there", () => {
    refuses(repo({ "core/adapters/crm.ts": "export const x = 1;\n" }), 6, "adapter lives in");
  });

  it("refuses one at the root of this repository, which is not an instance", () => {
    refuses(repo({ "adapters/crm.ts": "export const x = 1;\n" }), 6, "adapter lives in");
  });

  it("refuses a domain that does not export its domain.yaml, which no instance could boot", () => {
    refuses(
      repo({ "domains/alpha/package.json": '{ "name": "@werunfoundry/alpha", "exports": {} }\n' }),
      6,
      "does not export",
    );
  });

  it("refuses a domain whose package an instance would look for under another name", () => {
    refuses(
      repo({
        "domains/alpha/package.json":
          '{ "name": "@werunfoundry/a", "exports": { "./domain.yaml": "./domain.yaml" } }\n',
      }),
      6,
      "looks for this domain",
    );
  });

  it("refuses a domain with no package.json", () => {
    refuses(repo({ "domains/alpha/package.json": undefined }), 6, "without a readable package.json");
  });

  it("refuses JSON no machine can read", () => {
    refuses(repo({ "core/tsconfig.json": '{ "a": 1 }\\n' }), 6, "not valid JSON");
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
