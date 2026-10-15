/**
 * gtm/contracts — where candidates come from, and who must never be touched.
 *
 * The two are separate methods on purpose. It is tempting to model protection
 * as a flag on a candidate row, and it is wrong: the protected set is not a
 * subset of the candidate set. An account can be protected while never having
 * appeared as a candidate, and that is exactly the case protection exists for.
 * One list would make those accounts invisible — present nowhere, therefore
 * excluded nowhere.
 *
 * `freshness` is not a convenience. Doctrine 6 says suppression fails closed on
 * freshness as well as reachability, because a source that answers cheerfully
 * with last week's rows looks like protection and is not. A caller that cannot
 * establish how old the protected set is must refuse to enrol — which it can
 * only do if the contract can be asked.
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";

/** The two routes. They are read separately and aged separately. */
export type TargetRoute = "candidates" | "protected";

export interface TargetListFreshness {
  route: TargetRoute;
  /** When the source last recomputed the list — not when we asked. */
  asOf: string;
  /** The source's own statement of its worst case, when it makes one. */
  declaredMaxLagMinutes?: number;
  /** Rows available, when the source can say cheaply. */
  approximateCount?: number;
}

export interface TargetPage<T> {
  items: T[];
  /** Absent means this was the last page. Opaque; never parsed. */
  nextCursor?: string;
}

export interface TargetQuery {
  cursor?: string;
  limit?: number;
  /**
   * Values the instance declared, passed through untouched. The engine does
   * not invent selectors: what the source accepts is the source's business.
   */
  params?: Record<string, string | number | boolean>;
}

export interface TargetCompany {
  /** The source's identifier, when it has one. */
  externalId?: string;
  name?: string;
  domain?: string;
  /**
   * The keys that name this company, as the source holds them (decision
   * 0024): a `domain` key, and a networked company id when the source has
   * one. Subject `company`. An adapter that fills it repeats `domain` among
   * its keys, so that the two never disagree, and puts nothing in it that the
   * source does not carry — a key derived from another is a guess (0016).
   *
   * Carried, not yet read: the enrolment path finds a company's people by
   * `domain`.
   */
  identity?: Identity;
  /** Everything else the source carries. Never interpreted by the engine. */
  attributes: Record<string, string | number | boolean | null>;
}

/**
 * Why an account is off limits. Generic by construction: the reason is for the
 * audit trail, never for logic — any reason here excludes, all of them equally.
 */
export type ProtectionReason =
  | "customer"
  | "open_opportunity"
  | "partner"
  | "do_not_contact"
  | "other";

export interface ProtectedAccount {
  externalId?: string;
  name?: string;
  domain?: string;
  reason: ProtectionReason;
  /** When the protection began, when the source knows. */
  since?: string;
}

export interface TargetList extends Contract {
  /**
   * How old each route is. Called before enrolment, not only before a scan:
   * an account can become protected between the scan and the send.
   */
  freshness(
    route: TargetRoute,
    ctx: CallContext,
  ): Promise<CallResult<TargetListFreshness>>;

  candidates(
    query: TargetQuery,
    ctx: CallContext,
  ): Promise<CallResult<TargetPage<TargetCompany>>>;

  /**
   * The full protected set, independent of any candidate query. A caller that
   * cannot read it to the last page has not read it: a partial protected set
   * is not protection, and the run stops.
   */
  protectedAccounts(
    query: TargetQuery,
    ctx: CallContext,
  ): Promise<CallResult<TargetPage<ProtectedAccount>>>;
}
