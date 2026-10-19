/**
 * Tests for kernel-migrate's logic, against a real database and the real
 * packages, found from the template the way an instance finds them.
 */

import { strict as assert } from "node:assert";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "pg";

import type { DomainManifest } from "../manifest/types.js";
import { dependencyOrder, migrate } from "./migrate.js";

const base = process.env.TEST_DATABASE_URL;
const database = `kernel_migrate_${process.pid}`;
let admin: Client;
let url = "";

before(async () => {
  if (!base) return;
  admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${database}`);
  const u = new URL(base);
  u.pathname = `/${database}`;
  url = u.toString();
});

after(async () => {
  if (admin) {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  }
});

const d = (name: string, dependsOn: string[] = []): DomainManifest => ({ name, version: "0", description: "x", schema: name, dependsOn });

describe("dependency order", () => {
  it("puts every domain after what it depends on", () => {
    assert.deepEqual(dependencyOrder([d("acquisition", ["relations"]), d("relations")]).order, ["relations", "acquisition"]);
  });

  it("refuses a cycle", () => {
    assert.match(dependencyOrder([d("a", ["b"]), d("b", ["a"])]).issues[0]?.message ?? "", /cycle/);
  });
});

describe("migrating the template's domains", { skip: base ? false : "TEST_DATABASE_URL is not set" }, () => {
  const root = join(import.meta.dirname, "../../template");

  it("installs core, relations and acquisition, in that order", async () => {
    const said: string[] = [];
    assert.equal(await migrate({ root, url, say: (l) => said.push(l) }), 0, said.join("\n"));
    assert.deepEqual(
      said.filter((l) => /: applied \d+ migration/.test(l)).map((l) => l.trim().split(":")[0]),
      ["core", "relations", "acquisition"],
      said.join("\n"),
    );
    const db = new Client({ connectionString: url });
    await db.connect();
    const { rows } = await db.query(
      "select table_schema || '.' || table_name as t from information_schema.tables where table_schema in ('core','relations','acquisition') order by 1",
    );
    await db.end();
    for (const t of ["core.run", "relations.person", "acquisition.person_state"]) assert.ok(rows.some((r) => r.t === t), `${t} missing`);
  });

  it("applies nothing the second time", async () => {
    const db = new Client({ connectionString: url });
    await db.connect();
    const count = async () => (await db.query("select count(*)::int as n from drizzle.__migrations_core")).rows[0].n as number;
    const before = await count();
    const said: string[] = [];
    assert.equal(await migrate({ root, url, say: (l) => said.push(l) }), 0);
    assert.equal(await count(), before);
    // Said, not only true: the second run reports that it applied nothing.
    assert.deepEqual(
      said.filter((l) => /: nothing to apply, \d+ already applied/.test(l)).map((l) => l.trim().split(":")[0]),
      ["core", "relations", "acquisition"],
      said.join("\n"),
    );
    await db.end();
  });
});
