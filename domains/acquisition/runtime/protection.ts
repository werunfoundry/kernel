/**
 * acquisition/runtime — reading the protected set (decisions 0004, 0019).
 *
 * One reading for every path that decides whom to look at or contact: the
 * enrolment path and the sourcing path ask the same question and must get the
 * same answer, so the rule lives once.
 *
 * It fails closed (doctrine 6): if the protected set cannot be read to its
 * last page, is older than the caller allows, says when it was computed in a
 * form that is not a time, or holds an account with nothing to recognise it
 * by, the answer is a refusal with the sentence the run records. A stale
 * answer is an inability to know, not a green light.
 *
 * Matching protects wide. A company is protected if its domain, its company
 * id on a network, or its identifier in the target list's own source, is a
 * protected account's (decision 0033) — any one of them; a person is
 * protected if any address they have is on a protected domain. Wrongly
 * skipping someone is recoverable; wrongly contacting them is not.
 *
 * **The protected set is read to protect, never as an identity.** Nothing
 * here is written to `relations`, reconciled or compared as an identity: no
 * key is created from it, and no difference between two of its rows, or
 * between two reads, is a conflict. A domain that comes with one company id
 * today and another tomorrow — several companies sharing a domain upstream,
 * one picked by an aggregation — protects under whichever ids it carries
 * when it is read.
 *
 * **A customer with no key is uncovered, and an uncovered customer nobody
 * acknowledged stops the run** (decision 0034). The source may group its
 * accounts by customer. A row with no key is harmless when another row of
 * the same customer has one: the customer is matched through that one. A
 * customer none of whose rows has a key can be matched by nothing, so it is
 * protected by nothing; the run stops and names it, unless a person has
 * acknowledged that customer as uncovered — then the run goes on, and says
 * which acknowledged customers it could not protect. The acknowledged set is
 * read by the caller and handed in; this function never writes it.
 *
 * **An account known by the source's own identifier alone is matched only
 * against a candidate** (decision 0068). That identifier is the target
 * list's, and a company recorded in `relations` does not carry it: a path
 * that judges recorded companies — the enrolment, which takes its people from
 * a list, and the stop of what already runs (0057) — can match such an
 * account against nothing. They are listed here, for those paths to refuse
 * or to name; sourcing, which judges the target list's own candidates,
 * matches them.
 */

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";

import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";

export interface Protection {
  /**
   * When the protected set was computed, as its source said (0041): what a
   * run that acted on it can say the promise held as of (0057).
   */
  asOf: string;
  /**
   * How many distinct accounts were read: one per customer when the source
   * names customers; otherwise rows that share a key — a domain, a company
   * id, an identifier — are one account, however many rows repeat it.
   */
  accounts: number;
  /** How many rows the source returned, duplicates included. */
  rows: number;
  /** What candidates are matched against: distinct domains and company ids. */
  surface: { domains: number; companyIds: number };
  /** Rows with no key whose customer is protected through another row. */
  unkeyedRowsOfCoveredCustomers: number;
  /**
   * Customers with no key on any of their rows, acknowledged as such: they
   * are protected by nothing, and the run went on because a person said so.
   */
  uncovered: { customerId: string; name?: string; rows: number }[];
  /**
   * Accounts whose only key is the source's own identifier (0068): matched
   * against a candidate, never against a company on record. Distinct by that
   * identifier.
   */
  bySourceIdOnly: { externalId: string; name?: string }[];
  /**
   * Whether a candidate company is protected, unreadable, or clear (decision
   * 0044). Protected by its domain or one of its ancestors, or by a company
   * id; `unreadable_key` when it carries a domain that is not a host and no
   * other key protects it.
   */
  verdict(c: TargetCompany): "protected" | "unreadable_key" | "clear";
  /**
   * The same verdict, without counting a hit: for a company already enrolled
   * through (0057), which is not a candidate of the run, and must not swell
   * what the run reports each entry excluded.
   */
  standing(c: TargetCompany): "protected" | "unreadable_key" | "clear";
  /** Whether a candidate company is excluded by protection: protected, or unreadable — fail closed (0044). */
  company(c: TargetCompany): boolean;
  /**
   * For each protected entry that matched — a domain, or a company id — how
   * many distinct candidates it excluded so far (0044). An entry excluding
   * far more than its share is seen in the run's report.
   */
  hits(): { entry: string; candidates: number }[];
  /**
   * Whether any address or domain this identity holds is protected. An
   * identity with no address cannot be found protected this way — which is
   * why a path that adds addresses asks again once it has.
   */
  person(p: Identity): boolean;
  /**
   * The protected domain a host falls under — itself or an ancestor (0044) —
   * or nothing. What a suppression lists for an account (0057): the domain
   * protection holds, which may be wider than the host it matched.
   */
  domainOf(host: string): string | undefined;
}

/**
 * A domain as protection compares it: the host it names (decision 0028). The
 * target list's two routes come from different sources, and one spelling a
 * company as `http://Example.com` must not let it past the other's `example.com`.
 */
const domainOf = hostOf;

/** One DNS label: letters, digits, and hyphens inside (0044). */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether a reduced domain is a host protection can compare: two labels or more, each one valid (0044). */
export function isHost(host: string): boolean {
  const labels = host.split(".");
  return host.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

/**
 * A host and its ancestors, down to two labels: `app.11x.ai`, `11x.ai`
 * (0044). No public suffix list bounds the walk; the protected set holds no
 * suffix, and where it would, the walk excludes more, never less.
 */
export function ancestry(host: string): string[] {
  const labels = host.split(".");
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join("."));
  return out;
}

export async function readProtection(
  targets: TargetList,
  limits: {
    maxAgeMinutes: number;
    now: Date;
    /** Customers a person acknowledged as uncovered (0034). Absent is none. */
    acknowledged?: ReadonlySet<string>;
  },
  ctx: CallContext,
): Promise<{ ok: true; protection: Protection } | { ok: false; stop: string }> {
  const stop = (why: string) => ({ ok: false as const, stop: `protection unavailable: ${why}` });

  const fresh = await targets.freshness("protected", ctx);
  if (!fresh.ok) return stop(`the protected set's age could not be read (${fresh.error.code}: ${fresh.error.message})`);
  const asOf = Date.parse(fresh.value.asOf);
  if (Number.isNaN(asOf)) return stop(`the protected set says it is from "${fresh.value.asOf}", which is not a time`);
  const ageMinutes = (limits.now.getTime() - asOf) / 60_000;
  if (ageMinutes > limits.maxAgeMinutes) {
    return stop(`the protected set is ${Math.round(ageMinutes)} minutes old, older than the ${limits.maxAgeMinutes} allowed`);
  }

  const domains = new Set<string>();
  const ids = new Set<string>();
  /** Networked company ids, as `kind \n network \n value`: the network is part of the key. */
  const companyIds = new Set<string>();
  const seenCursors = new Set<string>();
  // Distinct accounts: rows joined by any key they share (union–find).
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(k, root);
    return root;
  };
  const union = (keys: string[]) => {
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    for (const k of keys.slice(1)) parent.set(find(k), find(keys[0]!));
  };
  let rows = 0;
  const bySourceIdOnly = new Map<string, { externalId: string; name?: string }>();
  /** Source ids some row also carries a domain or a company id beside: matched through those. */
  const idsWithAnotherKey = new Set<string>();
  /** Per customer: whether a row carries a key, how many rows, a name to say. */
  const customers = new Map<string, { keyed: boolean; rows: number; unkeyed: number; name?: string }>();
  let cursor: string | undefined;
  do {
    const page = await targets.protectedAccounts({ ...(cursor ? { cursor } : {}) }, ctx);
    if (!page.ok) return stop(`the protected set could not be read to its last page (${page.error.code}: ${page.error.message})`);
    for (const account of page.value.items as ProtectedAccount[]) {
      // A blank domain is no domain. One that is not blank must name a host,
      // or the set is not what it says it protects: the run stops (0044).
      const host = account.domain?.trim() ? domainOf(account.domain) : "";
      if (account.domain?.trim() && !isHost(host)) {
        return stop(`a protected row's domain is not a host: "${account.domain}"${account.customerId ? ` (customer ${account.customerId})` : ""}`);
      }
      const networked = (account.identity?.keys ?? [])
        .filter((k) => k.kind !== "domain" && k.network && k.value.trim() !== "")
        .map((k) => `${k.kind}\n${k.network}\n${k.value.trim()}`);
      const keyed = Boolean(host || account.externalId || networked.length > 0);
      rows++;
      if (account.customerId) {
        // Counted by customer, never matched by it.
        const c = customers.get(account.customerId) ?? { keyed: false, rows: 0, unkeyed: 0 };
        c.rows++;
        if (keyed) c.keyed = true;
        else c.unkeyed++;
        if (!c.name && account.name) c.name = account.name;
        customers.set(account.customerId, c);
      } else if (!keyed) {
        // No key and no customer to say whose it is: nothing can be matched
        // against it, and nobody can acknowledge it.
        return stop("a protected account has neither a domain, a company id nor an identifier, and names no customer, so nothing could be matched against it");
      }
      if (!keyed) continue;
      if (account.externalId && (host || networked.length > 0)) idsWithAnotherKey.add(account.externalId);
      else if (account.externalId && !bySourceIdOnly.has(account.externalId)) {
        bySourceIdOnly.set(account.externalId, { externalId: account.externalId, ...(account.name ? { name: account.name } : {}) });
      }
      if (host) domains.add(host);
      if (account.externalId) ids.add(account.externalId);
      for (const k of networked) companyIds.add(k);
      if (!account.customerId) {
        union([...(host ? [`domain\n${host}`] : []), ...(account.externalId ? [`id\n${account.externalId}`] : []), ...networked]);
      }
    }
    cursor = page.value.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) return stop("the protected set's pages loop");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);

  const uncovered = [...customers].filter(([, c]) => !c.keyed).map(([customerId, c]) => ({ customerId, ...(c.name ? { name: c.name } : {}), rows: c.rows }));
  const unknown = uncovered.filter((u) => !limits.acknowledged?.has(u.customerId));
  if (unknown.length > 0) {
    const named = unknown.map((u) => `${u.customerId}${u.name ? ` (${u.name})` : ""}, ${u.rows} row${u.rows === 1 ? "" : "s"}`).join("; ");
    return stop(
      `${unknown.length} protected customer${unknown.length === 1 ? " has" : "s have"} no key on any row, so nothing protects ${unknown.length === 1 ? "it" : "them"}, and nobody has acknowledged ${unknown.length === 1 ? "it" : "them"} as uncovered: ${named}`,
    );
  }
  const accounts = customers.size + new Set([...parent.keys()].map(find)).size;

  /** The protected domain a host falls under — itself or an ancestor — if any (0044). */
  const protectedHost = (host: string) => (isHost(host) ? ancestry(host).find((a) => domains.has(a)) : undefined);
  /** Per protected entry, the distinct candidates it excluded (0044). */
  const hits = new Map<string, Set<string>>();
  const judge = (c: TargetCompany, count: boolean): "protected" | "unreadable_key" | "clear" => {
    const raw = c.domain?.trim();
    const host = raw ? domainOf(raw) : "";
    const readable = !raw || isHost(host);
    const matched: string[] = [];
    const byDomain = readable && host ? protectedHost(host) : undefined;
    if (byDomain) matched.push(byDomain);
    if (c.externalId !== undefined && ids.has(c.externalId)) matched.push(`id ${c.externalId}`);
    for (const k of c.identity?.keys ?? []) {
      if (k.kind !== "domain" && k.network !== undefined && companyIds.has(`${k.kind}\n${k.network}\n${k.value.trim()}`)) matched.push(`${k.kind}@${k.network} ${k.value.trim()}`);
    }
    if (matched.length > 0) {
      if (!count) return "protected";
      const who = raw ?? c.externalId ?? c.name ?? JSON.stringify(c.identity ?? {});
      for (const entry of matched) hits.set(entry, (hits.get(entry) ?? new Set()).add(who));
      return "protected";
    }
    return readable ? "clear" : "unreadable_key";
  };
  const verdict = (c: TargetCompany) => judge(c, true);
  return {
    ok: true,
    protection: {
      asOf: fresh.value.asOf,
      accounts,
      rows,
      surface: { domains: domains.size, companyIds: companyIds.size },
      unkeyedRowsOfCoveredCustomers: [...customers.values()].filter((c) => c.keyed).reduce((n, c) => n + c.unkeyed, 0),
      uncovered,
      bySourceIdOnly: [...bySourceIdOnly.values()].filter((a) => !idsWithAnotherKey.has(a.externalId)).sort((a, b) => a.externalId.localeCompare(b.externalId)),
      verdict,
      standing: (c) => judge(c, false),
      company: (c) => verdict(c) !== "clear",
      hits: () =>
        [...hits].map(([entry, seen]) => ({ entry, candidates: seen.size })).sort((a, b) => b.candidates - a.candidates || a.entry.localeCompare(b.entry)),
      person: (p) =>
        p.keys.some(
          (k) =>
            (k.kind === "email" && protectedHost(domainOf(k.value.split("@")[1] ?? ""))) ||
            (k.kind === "domain" && protectedHost(domainOf(k.value))),
        ),
      domainOf: (host) => protectedHost(domainOf(host)),
    },
  };
}
