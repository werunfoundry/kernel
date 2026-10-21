/**
 * core/runtime — erasing a subject (decisions 0040, 0049).
 *
 * Not a cascade. Each domain declares, for each of its tables that names the
 * subject, what erasure does there — delete, anonymise, or keep under a
 * stated legal basis — and the core carries out the answers: the domains from
 * the top of the dependency order down, and in each, the subject's own row
 * last. That row is deleted, or, when a kept row elsewhere still points at
 * it, emptied of the columns its domain lists. One subject, one transaction,
 * one run with a person as actor.
 *
 * A row names the subject by id, or only by keys — a person a run excluded,
 * a dry run's — and both are theirs (0049). Before anything changes, the core
 * gathers the subject's keys: from its own row, as its domain says where they
 * are, and from the identities of every row reached by id; then each row
 * whose identity shares one key, until no new key is found.
 *
 * The core names no domain and no table here: everything it touches comes
 * from the declarations of the enabled domains, whose names and columns are
 * identifiers by validation.
 */

import type { SQL } from "drizzle-orm";
import { eq, sql } from "drizzle-orm";

import { run as runTable } from "../db/schema.js";

import { identityVocabulary, normalizeIdentity } from "../identity/index.js";
import type { IdentityKey, IdentityVocabulary } from "../identity/index.js";
import type { DomainManifest, ErasureRule } from "../manifest/types.js";
import type { Fingerprinter } from "./fingerprint.js";
import type { Registry } from "./resolve.js";
import { resolvePackage } from "./resolve.js";
import type { Database, Trigger } from "./run.js";
import { openRun } from "./run.js";

export interface ErasureStep {
  domain: string;
  table: string;
  /** The column naming the subject by id, when the rule reaches rows that way. */
  column?: string;
  /** The column holding an identity, when the rule reaches rows by keys (0049). */
  keys?: string;
  do: ErasureRule["do"];
  /** Rows naming the subject, by id or by keys, before anything was done. */
  rows: number;
  /** Of those, the rows reached only by keys. */
  byKeys?: number;
  basis?: string;
  /** For the subject's own row: deleted, or emptied because a kept row still names it. */
  outcome?: "deleted" | "emptied" | "kept" | "none";
}

/* -------------------------------------------------------------------------- */
/* The steps before erasure (decision 0056)                                   */
/* -------------------------------------------------------------------------- */

/** What a domain's step is given. The core reads none of it but the answer. */
export interface BeforeErasureInput {
  db: Database;
  /** The adapters the instance binds: the step reaches its provider through them. */
  registry: Registry;
  subjectId: string;
  /** The subject's keys, gathered as the rules will reach them (0049). */
  keys: IdentityKey[];
  /** The erasure's run. A plan has none: every call it makes is a dry run. */
  runId?: string;
  plan: boolean;
}

/** One thing the step did, or would do in a plan. */
export interface BeforeErasureAct {
  what: string;
  rows: number;
  /** The contract and the binding it went through, e.g. `sequencer (sandbox-sequencer)`. */
  through?: string;
}

/** Why a step could not do its part: the adapter, what it answered, and the remedy. */
export interface BeforeErasureRefusal {
  contract: string;
  /** The binding the adapter was reached through, or would have been. */
  binding: string;
  answered: string;
  /** Whether running the erasure again may fix it. When not, `remedy` says what would. */
  retry: boolean;
  remedy?: string;
}

export interface BeforeErasureResult {
  acts: BeforeErasureAct[];
  /** Empty when the step did all of its part. */
  refused: BeforeErasureRefusal[];
}

export type BeforeErasure = (input: BeforeErasureInput) => Promise<BeforeErasureResult>;

/* -------------------------------------------------------------------------- */
/* The steps inside the erasure's transaction (decision 0062)                 */
/* -------------------------------------------------------------------------- */

/** What a domain's step inside the transaction is given: no secret, and no adapter. */
export interface DuringErasureInput {
  /** The erasure's transaction. In a plan, the database, read only. */
  tx: Database;
  subjectId: string;
  /** The keys the transaction gathered, before any rule ran (0049). */
  keys: IdentityKey[];
  /** The erasure's run, and when it started. A plan has none. */
  run?: { id: string; startedAt: Date };
  /**
   * Whether the request includes not being contacted (0052, 0062). A plan
   * may be shown before the question is asked, and does not know.
   */
  objects?: boolean;
  /** Fingerprints under the version that writes, and the versions missing (0063). */
  fingerprints: Fingerprinter;
  plan: boolean;
}

export interface DuringErasureResult {
  acts: BeforeErasureAct[];
}

export type DuringErasure = (input: DuringErasureInput) => Promise<DuringErasureResult>;

/** What erase() needs to run the steps: the bound adapters, and where to resolve a domain's package. */
export interface ErasureReach {
  registry: Registry;
  /** The instance root, from which `@werunfoundry/<name>/…` resolves (0007). */
  root: string;
  /** What boot hands an erasure to fingerprint with (0062). A step inside the transaction needs it. */
  fingerprints?: Fingerprinter;
  /** Injected only where a test must; the default resolves and imports, as for an adapter. */
  importModule?: (href: string) => Promise<unknown>;
}

/** A step refused: nothing was erased (0056). The message says who failed and what to do. */
export class ErasureRefused extends Error {
  constructor(
    readonly domain: string,
    readonly refused: readonly BeforeErasureRefusal[],
  ) {
    super(
      [
        `erasure refused: ${domain}'s step before erasure could not do its part, so nothing was erased`,
        ...refused.map((r) =>
          r.retry
            ? `  - the ${r.contract} adapter bound as "${r.binding}" answered: ${r.answered}. Running the erasure again is the remedy.`
            : `  - the ${r.contract} adapter bound as "${r.binding}": ${r.answered}. Running the erasure again will not fix this: ${r.remedy ?? "nothing the kernel can do will"}.`,
        ),
      ].join("\n"),
    );
  }
}

/** Each domain's step of one kind, upper domains first — the order the rules follow (0056, 0062). */
async function loadSteps<K extends "beforeErasure" | "duringErasure">(
  domains: readonly DomainManifest[],
  reach: ErasureReach | undefined,
  kind: K,
): Promise<{ domain: string; run: K extends "beforeErasure" ? BeforeErasure : DuringErasure }[]> {
  type Run = K extends "beforeErasure" ? BeforeErasure : DuringErasure;
  const decision = kind === "beforeErasure" ? "0056" : "0062";
  const out: { domain: string; run: Run }[] = [];
  for (const d of order(domains)) {
    const named = d[kind];
    if (named === undefined) continue;
    // Failing closed: a step nobody can run is a step not done.
    if (!reach) throw new ErasureRefused(d.name, [{ contract: "erasure", binding: named, answered: "this erasure was given no bound adapters to run it with", retry: false, remedy: "erase through `kernel-erase`, which boots the instance" }]);
    if (kind === "duringErasure" && !reach.fingerprints) {
      throw new ErasureRefused(d.name, [{ contract: "erasure", binding: named, answered: "this erasure was given no fingerprint versions to write under", retry: false, remedy: "erase through `kernel-erase`, which boots the instance and checks them (decision 0062)" }]);
    }
    const load = reach.importModule ?? ((href: string) => import(href));
    const module = (await load(resolvePackage(named, reach.root))) as Record<string, unknown>;
    if (typeof module[kind] !== "function") throw new Error(`${named} exports no \`${kind}\` function (decision ${decision})`);
    out.push({ domain: d.name, run: module[kind] as Run });
  }
  return out;
}

/** A gathered key, as an identity carries it. */
const asIdentityKey = (k: Key): IdentityKey => (k.network ? { kind: k.kind, network: k.network, value: k.value } : { kind: k.kind, value: k.value });

/**
 * What an erasure does not reach (decision 0049), said wherever one is shown:
 * on the plan, before the confirmation, after the erasure. Silence about it
 * would read as coverage.
 */
export const NOT_REACHED: readonly string[] = [
  "backups of the database: they expire on the instance's retention; after a restore, the erasures are run again — the kernel keeps no register of who was erased, because it would name them",
  "execution logs: the output of the commands that ran, wherever the instance keeps it",
  "working copies: dumps, exports, copies of the database, target lists",
  "core.event payloads, which name a person by keys and are append-only",
  "core.run.error, free text that may quote a provider's answer",
  // Erasure suspends every enrolment a provider may still hold before it
  // forgets the person (0056), or is refused. What a suspension leaves:
  "the sequencer's steps already on their way: a step the provider had picked to send before the suspension took effect still leaves (0051); the touches pull is where it would show",
  "what the provider keeps of the person once suspended: what its adapter declares its suspension costs, as `kernel-enrol` prints them; deleting the person there is not done (0056)",
  "enrolments the kernel did not make: someone added to a sequence by hand at the provider, or by another tool, is in no registry row, and erasure does not stop them",
];

/** Upper domains first: a domain is erased before every domain it depends on. */
function order(domains: readonly DomainManifest[]): DomainManifest[] {
  const byName = new Map(domains.map((d) => [d.name, d]));
  const done = new Set<string>();
  const out: DomainManifest[] = [];
  const visit = (d: DomainManifest) => {
    if (done.has(d.name)) return;
    done.add(d.name);
    for (const dep of d.dependsOn) if (byName.has(dep)) visit(byName.get(dep)!);
    out.push(d);
  };
  for (const d of domains) visit(d);
  return out.reverse();
}

/** Within a domain, the subject's own row — a rule on `id` — after every other. */
const steps = (domains: readonly DomainManifest[]) =>
  order(domains).flatMap((d) =>
    [...(d.erasure ?? [])].sort((a, b) => Number(a.column === "id") - Number(b.column === "id")).map((rule) => ({ schema: d.schema, domain: d.name, rule })),
  );

type Step = ReturnType<typeof steps>[number];

const target = (schema: string, table: string) => sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
const keysOf = (rule: ErasureRule) => ("keys" in rule ? rule.keys : undefined);

// The driver's result is the instance's (0010); node-postgres gives `rows`.
const select = async <T>(db: Database, query: SQL) => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/** A key as it is compared: the vocabulary's form (0013), network empty when none. */
type Key = { kind: string; network: string; value: string };
const idOf = (k: Key) => `${k.kind}\u0000${k.network}\u0000${k.value}`;

/**
 * Rows whose identity in `column` shares one of `keys`. Compared as the
 * vocabulary says: without case where the kind ignores it. A kind naming a
 * host is compared without case too, which is what its form mostly is; a
 * person's identity carries none.
 */
function sharesKey(table: string, column: string, keys: readonly Key[], vocabulary: IdentityVocabulary): SQL {
  if (keys.length === 0) return sql`false`;
  const each = keys.map((k) => {
    const kind = vocabulary.kinds.get(k.kind);
    const value = kind?.caseInsensitive || kind?.hostname ? sql`lower(btrim(e->>'value'))` : sql`btrim(e->>'value')`;
    return sql`(e->>'kind' = ${k.kind} and coalesce(e->>'network', '') = ${k.network} and ${value} = ${k.value})`;
  });
  const identity = sql`${sql.identifier(table)}.${sql.identifier(column)}`;
  return sql`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${identity}->'keys') = 'array' then ${identity}->'keys' else '[]'::jsonb end) as k(e) where ${sql.join(each, sql` or `)})`;
}

const byId = (rule: ErasureRule, id: string) => (rule.column === undefined ? sql`false` : sql`${sql.identifier(rule.column)} = ${id}`);

/** Every row the rule reaches: by id, or by a key the subject is known by. */
function reached(rule: ErasureRule, id: string, keys: readonly Key[], vocabulary: IdentityVocabulary): SQL {
  const k = keysOf(rule);
  return k === undefined ? byId(rule, id) : sql`(${byId(rule, id)}) or ${sharesKey(rule.table, k, keys, vocabulary)}`;
}

/**
 * The subject's keys, gathered before anything changes: from its own row,
 * where its domain says they are, and from the identity of every row reached,
 * until no new key is found. Reaching a row wrongly empties a history row of
 * its keys; missing one leaves a person's data where it was (0049).
 */
async function subjectKeys(db: Database, all: readonly Step[], id: string, vocabulary: IdentityVocabulary): Promise<Key[]> {
  const found = new Map<string, Key>();
  const add = (key: IdentityKey): boolean => {
    if (typeof key?.kind !== "string" || typeof key.value !== "string" || key.value.trim() === "") return false;
    const [n] = normalizeIdentity({ subject: "", keys: [key] }, vocabulary).keys;
    const k: Key = { kind: n!.kind, network: n!.network ?? "", value: n!.value };
    if (found.has(idOf(k))) return false;
    found.set(idOf(k), k);
    return true;
  };

  for (const { schema, rule } of all) {
    if (rule.do !== "delete" || !rule.keyColumns) continue;
    const columns = Object.entries(rule.keyColumns);
    const [row] = await select<Record<string, string | null>>(
      db,
      sql`select ${sql.join(columns.map(([, c]) => sql.identifier(c)), sql`, `)} from ${target(schema, rule.table)} where ${byId(rule, id)}`,
    );
    for (const [kind, column] of columns) {
      const held = row?.[column];
      if (!held) continue;
      // A networked key is held as `<network>:<value>` (0013).
      const cut = held.indexOf(":");
      if (vocabulary.kinds.get(kind)?.networked) {
        if (cut > 0) add({ kind, network: held.slice(0, cut), value: held.slice(cut + 1) });
      } else add({ kind, value: held });
    }
  }

  const keyed = all.filter((s) => keysOf(s.rule) !== undefined);
  for (let more = keyed.length > 0; more; ) {
    more = false;
    for (const { schema, rule } of keyed) {
      const column = keysOf(rule)!;
      const rows = await select<{ identity: { keys?: IdentityKey[] } | null }>(
        db,
        sql`select ${sql.identifier(column)} as identity from ${target(schema, rule.table)} where ${reached(rule, id, [...found.values()], vocabulary)}`,
      );
      for (const r of rows) for (const key of Array.isArray(r.identity?.keys) ? r.identity.keys : []) more = add(key) || more;
    }
  }
  return [...found.values()];
}

async function count(db: Database, step: Step, id: string, keys: readonly Key[], vocabulary: IdentityVocabulary): Promise<Pick<ErasureStep, "rows" | "byKeys">> {
  const { schema, rule } = step;
  const k = keysOf(rule);
  const onlyByKeys = k === undefined ? sql`false` : sql`not coalesce(${byId(rule, id)}, false) and ${sharesKey(rule.table, k, keys, vocabulary)}`;
  const [r] = await select<{ n: number; k: number }>(
    db,
    sql`select count(*)::int as n, count(*) filter (where ${onlyByKeys})::int as k from ${target(schema, rule.table)} where ${reached(rule, id, keys, vocabulary)}`,
  );
  return { rows: Number(r!.n), ...(k === undefined ? {} : { byKeys: Number(r!.k) }) };
}

const stepOf = (step: Step, counted: Pick<ErasureStep, "rows" | "byKeys">): ErasureStep => {
  const { domain, rule } = step;
  const k = keysOf(rule);
  return {
    domain,
    table: rule.table,
    ...(rule.column === undefined ? {} : { column: rule.column }),
    ...(k === undefined ? {} : { keys: k }),
    do: rule.do,
    ...counted,
    ...(rule.do === "keep" ? { basis: rule.basis } : {}),
  };
};

/** What erasing the subject would do, domain by domain. Reads only. */
export async function planErasure(db: Database, domains: readonly DomainManifest[], subjectId: string): Promise<ErasureStep[]> {
  const vocabulary = identityVocabulary(domains);
  const all = steps(domains);
  const keys = await subjectKeys(db, all, subjectId, vocabulary);
  const plan: ErasureStep[] = [];
  for (const step of all) plan.push(stepOf(step, await count(db, step, subjectId, keys, vocabulary)));
  return plan;
}

/**
 * What each domain's step before erasure would do (0056), as dry runs.
 * Reads only, here and at the providers.
 */
export async function planBeforeErasure(
  db: Database,
  domains: readonly DomainManifest[],
  subjectId: string,
  reach: ErasureReach | undefined,
): Promise<{ domain: string; result: BeforeErasureResult }[]> {
  const loaded = await loadSteps(domains, reach, "beforeErasure");
  if (loaded.length === 0) return [];
  const vocabulary = identityVocabulary(domains);
  const keys = (await subjectKeys(db, steps(domains), subjectId, vocabulary)).map(asIdentityKey);
  const out: { domain: string; result: BeforeErasureResult }[] = [];
  for (const { domain, run } of loaded) out.push({ domain, result: await run({ db, registry: reach!.registry, subjectId, keys, plan: true }) });
  return out;
}

/**
 * What each domain's step inside the transaction would do (0062), read
 * without a transaction. The question may not have been asked yet: a step
 * says what it would do under either answer.
 */
export async function planDuringErasure(
  db: Database,
  domains: readonly DomainManifest[],
  subjectId: string,
  reach: ErasureReach | undefined,
  objects?: boolean,
): Promise<{ domain: string; result: DuringErasureResult }[]> {
  const loaded = await loadSteps(domains, reach, "duringErasure");
  if (loaded.length === 0) return [];
  const vocabulary = identityVocabulary(domains);
  const keys = (await subjectKeys(db, steps(domains), subjectId, vocabulary)).map(asIdentityKey);
  const out: { domain: string; result: DuringErasureResult }[] = [];
  for (const { domain, run } of loaded) {
    out.push({ domain, result: await run({ tx: db, subjectId, keys, fingerprints: reach!.fingerprints!, plan: true, ...(objects === undefined ? {} : { objects }) }) });
  }
  return out;
}

/** What an anonymisation writes: emptied, stripped, made random, or a fixed sentence. */
function anonymisation(rule: Extract<ErasureRule, { do: "anonymise" }>): SQL {
  const set: SQL[] = [];
  for (const c of rule.columns ?? []) set.push(sql`${sql.identifier(c)} = null`);
  for (const [c, paths] of Object.entries(rule.strip ?? {})) {
    const column = sql.identifier(c);
    const stripped = paths.reduce<SQL>((acc, p) => sql`(${acc} #- ${`{${p.split(".").join(",")}}`}::text[])`, sql`e`);
    set.push(
      sql`${column} = case when jsonb_typeof(${column}) = 'array' then (select coalesce(jsonb_agg(${stripped} order by i), '[]'::jsonb) from jsonb_array_elements(${column}) with ordinality as k(e, i)) else ${column} end`,
    );
  }
  // Derived from nothing: not a hash of what was there, under any algorithm or salt.
  for (const c of rule.random ?? []) set.push(sql`${sql.identifier(c)} = 'erased:' || gen_random_uuid()::text`);
  // Only where the column holds something (0053): a rule never invents a
  // sentence where there was none, nor fills a column a check keeps empty.
  // Comparing to the column itself lets a jsonb column take a JSON document.
  for (const [c, text] of Object.entries(rule.text ?? {})) {
    const column = sql.identifier(c);
    set.push(sql`${column} = case when ${column} is null then ${column} else ${text} end`);
  }
  return sql.join(set, sql`, `);
}

/**
 * Carries the plan out, as a person's run. All of it, or none of it. The caller
 * says how the run was reached (decision 0048).
 *
 * First the domains' steps before erasure (0056), upper domains first and
 * outside the transaction: a call to a provider cannot be rolled back with
 * one, and must not hold one open. A step that could not do its part refuses
 * the erasure, which then changes nothing here; what the steps already did
 * stays done and recorded, and a retry finds it so. Then, in one
 * transaction, the domains' steps inside it (0062) — what must commit or
 * roll back with the deletion — and the rules.
 *
 * The caller says whether the request includes not being contacted (0052,
 * 0062), true or false, and an erasure that says neither is refused: the
 * answer decides whether an objection outlives the person, and nothing may
 * give it by default.
 */
export async function erase(
  db: Database,
  domains: readonly DomainManifest[],
  input: { subjectId: string; by: string; processKey: string; trigger: Trigger; objects: boolean },
  reach?: ErasureReach,
): Promise<{ runId: string; steps: ErasureStep[]; before: { domain: string; acts: BeforeErasureAct[] }[]; during: { domain: string; acts: BeforeErasureAct[] }[] }> {
  const by = input.by.trim();
  if (by === "") throw new Error("who erases is required: erasing is a person's act");
  // Typed, and checked again for a caller the compiler never saw.
  if (typeof (input as { objects?: unknown }).objects !== "boolean") {
    throw new Error("an erasure says whether the request includes not being contacted, true or false (decision 0062); nothing was erased");
  }
  const vocabulary = identityVocabulary(domains);
  // Loaded before the run opens: a step that cannot be loaded erases nobody.
  const inside = await loadSteps(domains, reach, "duringErasure");
  const open = await openRun(db, { processKey: input.processKey, trigger: input.trigger, actor: { type: "human", id: by }, dryRun: false });
  try {
    const before: { domain: string; acts: BeforeErasureAct[] }[] = [];
    const during: { domain: string; acts: BeforeErasureAct[] }[] = [];
    const loaded = await loadSteps(domains, reach, "beforeErasure");
    if (loaded.length > 0) {
      const keys = (await subjectKeys(db, steps(domains), input.subjectId, vocabulary)).map(asIdentityKey);
      for (const { domain, run } of loaded) {
        const r = await run({ db, registry: reach!.registry, subjectId: input.subjectId, keys, runId: open.id, plan: false });
        if (r.refused.length > 0) throw new ErasureRefused(domain, r.refused);
        before.push({ domain, acts: r.acts });
      }
    }
    const done = (await db.transaction(async (tx) => {
      const all = steps(domains);
      // Gathered first: the rows that hold the keys are the ones about to be emptied.
      const keys = await subjectKeys(tx, all, input.subjectId, vocabulary);
      if (inside.length > 0) {
        const [started] = await tx.select({ at: runTable.startedAt }).from(runTable).where(eq(runTable.id, open.id));
        for (const { domain, run } of inside) {
          const r = await run({
            tx,
            subjectId: input.subjectId,
            keys: keys.map(asIdentityKey),
            run: { id: open.id, startedAt: started!.at },
            objects: input.objects,
            fingerprints: reach!.fingerprints!,
            plan: false,
          });
          during.push({ domain, acts: r.acts });
        }
      }
      const out: ErasureStep[] = [];
      for (const s of all) {
        const { schema, rule } = s;
        const step = stepOf(s, await count(tx, s, input.subjectId, keys, vocabulary));
        const where = reached(rule, input.subjectId, keys, vocabulary);
        if (rule.do === "delete" && rule.column === "id" && rule.ifStillNamed) {
          // Its own row: deleted, unless a kept row still points at it.
          step.outcome = step.rows === 0 ? "none" : "deleted";
          if (step.rows > 0) {
            try {
              await tx.transaction(async (sp) => {
                await sp.execute(sql`delete from ${target(schema, rule.table)} where ${where}`);
              });
            } catch (error) {
              if ((error as { cause?: { code?: string }; code?: string }).cause?.code !== "23503" && (error as { code?: string }).code !== "23503") throw error;
              const set = sql.join(rule.ifStillNamed.map((c) => sql`${sql.identifier(c)} = null`), sql`, `);
              await tx.execute(sql`update ${target(schema, rule.table)} set ${set} where ${where}`);
              step.outcome = "emptied";
            }
          }
        } else if (rule.do === "delete") {
          await tx.execute(sql`delete from ${target(schema, rule.table)} where ${where}`);
        } else if (rule.do === "anonymise") {
          await tx.execute(sql`update ${target(schema, rule.table)} set ${anonymisation(rule)} where ${where}`);
        } else {
          step.outcome = "kept";
        }
        out.push(step);
      }
      return out;
    })) as ErasureStep[];
    await open.finish({ status: "succeeded" });
    return { runId: open.id, steps: done, before, during };
  } catch (error) {
    await open.finish({ status: "failed", error: (error as Error).message.slice(0, 500) }).catch(() => {});
    throw error;
  }
}
