#!/usr/bin/env node
/**
 * kernel-source — the sourcing path (decision 0031), run from an instance's
 * root, usually as `pnpm source -- --max-age 60 --max-people 10 --want email`.
 *
 * A dry run unless `--live` is given. A dry run submits no paid completion
 * and records nobody; a live run pays for completions — at most
 * `--max-people` of them — and records the people it keeps. It enrols
 * nobody, in either mode.
 *
 *   --max-age <min>       how old the protected set may be; required
 *   --max-people <n>      the most people completed, and so paid for; required
 *   --want <kind>         a key kind a kept person must have; repeatable; default email
 *   --per-company <n>     how many people to look up at each company; default 5
 *   --limit <n>           how many candidate companies to read
 *   --live                actually pay for completions and record people
 *
 * Exits 0 when the run succeeded, 1 otherwise.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { boot } from "@werunfoundry/core/runtime/boot";
import { connect } from "@werunfoundry/core/runtime/connect";

import type { Looked } from "../runtime/source.js";
import { source } from "../runtime/source.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const values = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]!] : []));
const value = (name: string) => values(name)[0];

const who = (l: Looked) =>
  l.person?.keys.find((k) => k.kind === "email")?.value ??
  l.person?.keys.find((k) => k.kind === "social_profile_handle")?.value ??
  l.person?.keys[0]?.value ??
  l.company.domain ??
  l.company.name ??
  "?";
const money = (xs: { provider: string; amount: number; unit: string }[]) =>
  xs.length === 0 ? "nothing reported" : xs.map((x) => `${x.amount} ${x.unit} at ${x.provider}`).join(", ");

async function main(): Promise<number> {
  const root = process.cwd();
  const envFile = join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const maxAge = Number(value("max-age"));
  const maxPeople = Number(value("max-people"));
  if (!(maxAge > 0) || !(Number.isInteger(maxPeople) && maxPeople > 0)) {
    console.log("source: --max-age (minutes) and --max-people are required: there is no default age for protection, nor a default number of paid lookups.");
    return 1;
  }

  const booted = await boot({ root, env: process.env });
  if (!booted.ok) {
    for (const i of booted.issues) console.log(`  ✖ ${i.at.replace(`${root}/`, "")}\n      ${i.message}`);
    console.log("\nsource: boot refused. Nothing was opened or called.");
    return 1;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("source: DATABASE_URL is not set — a run must be recorded.");
    return 1;
  }

  let connection;
  try {
    connection = await connect(url, root, "source");
  } catch (error) {
    console.log(`source: cannot reach the database — ${(error as Error).message}`);
    return 1;
  }
  try {
    const limit = Number(value("limit"));
    const perCompany = Number(value("per-company"));
    let report;
    try {
      report = await source(
        { db: connection.db, registry: booted.registry, identity: booted.identity },
        {
          maxPeople,
          want: values("want").length ? values("want") : ["email"],
          protectedMaxAgeMinutes: maxAge,
          dryRun: !flag("live"),
          trigger: "cli",
          actor: { type: "human" },
          ...(limit > 0 ? { query: { limit } } : {}),
          ...(perCompany > 0 ? { peoplePerCompany: perCompany } : {}),
        },
      );
    } catch (error) {
      const cause = (error as Error).cause;
      console.log(`source: ${cause instanceof Error ? cause.message : (error as Error).message.split("\n")[0]}`);
      console.log("     have the engine's migrations been applied, and is every contract bound?");
      return 1;
    }

    const list = (title: string, these: Looked[]) => {
      if (these.length === 0) return;
      console.log(`    ${title}: ${these.length}`);
      for (const l of these) console.log(`      - ${who(l)}: ${l.detail}`);
    };
    const by = (pass: Looked["pass"], outcome: Looked["outcome"]) => report.looked.filter((l) => l.pass === pass && l.outcome === outcome);
    const companyExcluded = report.looked.filter((l) => l.pass === "company" && l.outcome !== "not_reached");
    const kept = by("person", "kept");

    console.log(`run: ${report.runId} — ${report.dryRun ? "dry run" : "live"} — ${report.status}`);
    if (report.stoppedBy) console.log(`  stopped: ${report.stoppedBy}`);
    console.log(`  protected accounts read: ${report.protectedAccounts} distinct, from ${report.protectedRows} rows`);
    if (report.protection) {
      const p = report.protection;
      console.log(`    matched on ${p.surface.domains} domains and ${p.surface.companyIds} company ids; ${p.unkeyedRowsOfCoveredCustomers} rows with no key, of customers protected through another row`);
      if (p.uncovered.length > 0) {
        console.log(`    ! protected by nothing, acknowledged as uncovered: ${p.uncovered.length}`);
        for (const u of p.uncovered) console.log(`      - ${u.customerId}${u.name ? ` (${u.name})` : ""}: ${u.rows} row${u.rows === 1 ? "" : "s"}, no key`);
      }
    }
    console.log(`  candidates: ${report.candidates}`);
    const c = report.companyPass;
    console.log(
      `  company pass: ${c.survived} of ${c.wanted} wanted survived; ${c.examined} examined; ${c.skippedAsExamined} skipped, examined by an earlier run` +
        (c.exhausted ? " — the candidates ran out first" : ""),
    );
    console.log(`  company pass, before anything was spent — excluded: ${companyExcluded.length}`);
    for (const o of ["protected", "known_to_crm", "unreachable"] as const) list(o, by("company", o));
    const a = report.avoidedByCompanyPass;
    console.log(`    spared: ${a.peopleSearches} people searches, and at most ${a.completionsAtMost} completions`);
    list("not reached, the ceiling came first", by("company", "not_reached"));
    console.log(`  people searches: ${report.peopleSearches}; people taken: ${report.peopleTaken} of at most ${maxPeople}; sent to an enrichment source: ${report.completions}`);
    // A protected person is excluded before paying when an address the
    // people source gave is protected, after completion when one it added is.
    const protectedBefore = by("person", "protected").filter((l) => /not completed/.test(l.detail));
    const protectedAfter = by("person", "protected").filter((l) => !/not completed/.test(l.detail));
    console.log(`  before paying — excluded: ${report.avoidedBeforeCompletion}, each one completion spared`);
    list("duplicate", by("person", "duplicate"));
    list("protected", protectedBefore);
    const personPass = [...protectedAfter, ...by("person", "known_to_crm"), ...by("person", "opted_out")];
    console.log(`  person pass, after completion — excluded: ${personPass.length}; already paid for, see below`);
    list("protected", protectedAfter);
    list("known_to_crm", by("person", "known_to_crm"));
    list("opted_out", by("person", "opted_out"));
    for (const o of ["incomplete", "unreachable", "not_reached", "simulated"] as const) list(o, by("person", o));
    console.log(`  ${report.dryRun ? "would keep" : "kept"}: ${kept.length}`);
    for (const l of kept) {
      const said = l.said?.map((s) => `${s.key.value} ${s.status}`).join(", ");
      console.log(`    + ${who(l)}${said ? ` (${said})` : ""}`);
    }
    console.log(`  spent: ${money(report.spent)}`);
    console.log(`  of which on people then excluded: ${money(report.spentOnExcludedPeople)}`);
    if (!report.recorded) console.log("  ! the run row could not be closed; this output is the only record of the run");
    return report.status === "succeeded" && report.recorded ? 0 : 1;
  } finally {
    await connection.end().catch(() => {});
  }
}

process.exitCode = await main();
