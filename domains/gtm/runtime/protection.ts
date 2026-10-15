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
 * Matching protects wide. A company is protected if its domain, or its
 * identifier in the target list's own source, is a protected account's; a
 * person is protected if any address they have is on a protected domain.
 * Wrongly skipping someone is recoverable; wrongly contacting them is not.
 */

import type { CallContext } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";
import { hostOf } from "@werunfoundry/core/identity";

import type { ProtectedAccount, TargetCompany, TargetList } from "../contracts/target-list.js";

export interface Protection {
  /** How many protected accounts were read. */
  accounts: number;
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
  const seenCursors = new Set<string>();
  let accounts = 0;
  let cursor: string | undefined;
  do {
    const page = await targets.protectedAccounts({ ...(cursor ? { cursor } : {}) }, ctx);
    if (!page.ok) return stop(`the protected set could not be read to its last page (${page.error.code}: ${page.error.message})`);
    for (const account of page.value.items as ProtectedAccount[]) {
      // A "domain" that names no host — `http://`, a blank — matches
      // nothing, so it is no domain at all.
      const host = account.domain ? domainOf(account.domain) : "";
      if (!host && !account.externalId) {
        return stop("a protected account has neither a domain nor an identifier, so nothing could be matched against it");
      }
      if (host) domains.add(host);
      if (account.externalId) ids.add(account.externalId);
      accounts++;
    }
    cursor = page.value.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) return stop("the protected set's pages loop");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);

  return {
    ok: true,
    protection: {
      accounts,
      company: (c) =>
        (c.domain !== undefined && domains.has(domainOf(c.domain))) || (c.externalId !== undefined && ids.has(c.externalId)),
      person: (p) =>
        p.keys.some(
          (k) =>
            (k.kind === "email" && domains.has(domainOf(k.value.split("@")[1] ?? ""))) ||
            (k.kind === "domain" && domains.has(domainOf(k.value))),
        ),
    },
  };
}
