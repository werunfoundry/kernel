/**
 * gtm/runtime — reading the protected set (decisions 0004, 0019).
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
 */

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";

import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";

export interface Protection {
  /**
   * How many distinct accounts were read: rows that share a key — a domain,
   * a company id, an identifier — are one account, however many rows the
   * source repeats it on.
   */
  accounts: number;
  /** How many rows the source returned, duplicates included. */
  rows: number;
  company(c: TargetCompany): boolean;
  /**
   * Whether any address or domain this identity holds is protected. An
   * identity with no address cannot be found protected this way — which is
   * why a path that adds addresses asks again once it has.
   */
  person(p: Identity): boolean;
}

/**
 * A domain as protection compares it: the host it names (decision 0028). The
 * target list's two routes come from different sources, and one spelling a
 * company as `http://Example.com` must not let it past the other's `example.com`.
 */
const domainOf = hostOf;

export async function readProtection(
  targets: TargetList,
  limits: { maxAgeMinutes: number; now: Date },
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
  let cursor: string | undefined;
  do {
    const page = await targets.protectedAccounts({ ...(cursor ? { cursor } : {}) }, ctx);
    if (!page.ok) return stop(`the protected set could not be read to its last page (${page.error.code}: ${page.error.message})`);
    for (const account of page.value.items as ProtectedAccount[]) {
      // A "domain" that names no host — `http://`, a blank — matches
      // nothing, so it is no domain at all.
      const host = account.domain ? domainOf(account.domain) : "";
      const networked = (account.identity?.keys ?? [])
        .filter((k) => k.kind !== "domain" && k.network && k.value.trim() !== "")
        .map((k) => `${k.kind}\n${k.network}\n${k.value.trim()}`);
      if (!host && !account.externalId && networked.length === 0) {
        return stop("a protected account has neither a domain, a company id nor an identifier, so nothing could be matched against it");
      }
      if (host) domains.add(host);
      if (account.externalId) ids.add(account.externalId);
      for (const k of networked) companyIds.add(k);
      union([...(host ? [`domain\n${host}`] : []), ...(account.externalId ? [`id\n${account.externalId}`] : []), ...networked]);
      rows++;
    }
    cursor = page.value.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) return stop("the protected set's pages loop");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);

  const accounts = new Set([...parent.keys()].map(find)).size;
  return {
    ok: true,
    protection: {
      accounts,
      rows,
      company: (c) =>
        (c.domain !== undefined && domains.has(domainOf(c.domain))) ||
        (c.externalId !== undefined && ids.has(c.externalId)) ||
        (c.identity?.keys ?? []).some((k) => k.kind !== "domain" && k.network !== undefined && companyIds.has(`${k.kind}\n${k.network}\n${k.value.trim()}`)),
      person: (p) =>
        p.keys.some(
          (k) =>
            (k.kind === "email" && domains.has(domainOf(k.value.split("@")[1] ?? ""))) ||
            (k.kind === "domain" && domains.has(domainOf(k.value))),
        ),
    },
  };
}
