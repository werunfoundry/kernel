/**
 * relations/contracts — the CRM.
 *
 * It lives in `relations` and not in the core because a CRM is a business
 * capability: it holds companies and people, which are this domain's objects.
 * No provider is named here (doctrine 6); the adapter names exactly one.
 *
 * Two shapes in this file are deliberate and will look like omissions.
 *
 * **There is no bulk import.** Not because no provider offers one, but
 * because the standing rule is that a record enters the CRM when a real
 * conversation starts, never when a contact is sourced. A contract with
 * `importMany()` in it makes the wrong thing the easy thing; the only write
 * here takes one subject and a reason. Sourced contacts live in `relations`
 * tables and in lists, where they belong, and cost nothing per seat.
 *
 * **Reads return a reference and the provider's own fields, nothing more.**
 * The CRM owns those fields (doctrine 3). The engine keeps the reference and
 * what it computes itself, and asks again when it needs the rest.
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";

/** How a record is addressed in the provider. Opaque; never parsed. */
export interface CrmRef {
  /** The provider's own identifier, as the provider writes it. */
  externalId: string;
  /** A link a human can open, when the provider gives one. */
  url?: string;
}

export interface CrmCompany {
  ref: CrmRef;
  name?: string;
  domain?: string;
  /** Whatever the instance declared it cares about. Never interpreted here. */
  fields: Record<string, string | number | boolean | null>;
}

export interface CrmPerson {
  ref: CrmRef;
  email?: string;
  fullName?: string;
  companyRef?: CrmRef;
  fields: Record<string, string | number | boolean | null>;
}

/** A read that found nothing is a success with `null`, never an error. */
export type CrmLookup<T> = CallResult<T | null>;

/**
 * Why a record is being created. A sourced contact is not one of these, and
 * that is the point: the enum is the rule, written where it cannot be
 * forgotten.
 */
export type CrmEntryReason =
  | "reply_received"
  | "meeting_booked"
  | "inbound_request"
  | "existing_relationship"
  | "manual";

export interface CrmRegistration {
  /** Supplied by the caller: the caller knows what "the same" means. */
  idempotencyKey: string;
  reason: CrmEntryReason;
  /** When the thing that justifies the record happened. */
  occurredAt: string;
  /** The row in this system that evidences it — an interaction, a draft. */
  evidenceRef?: { kind: string; id: string };
  company?: { name?: string; domain?: string };
  person: { email?: string; fullName?: string };
}

export interface CrmRegistrationResult {
  person: CrmPerson;
  company?: CrmCompany;
  /** True when the record already existed and nothing was created. */
  existed: boolean;
}

/** A note attached to a record. Append-only: the CRM is not our log. */
export interface CrmNote {
  idempotencyKey: string;
  subject: CrmRef;
  body: string;
  occurredAt: string;
}

export interface Crm extends Contract {
  findCompanyByDomain(
    domain: string,
    ctx: CallContext,
  ): Promise<CrmLookup<CrmCompany>>;

  findPersonByEmail(
    email: string,
    ctx: CallContext,
  ): Promise<CrmLookup<CrmPerson>>;

  /**
   * The only write that creates. One subject, one reason, one key.
   * Under `dryRun` an adapter performs the lookup and returns what it would
   * have created, with `simulated: true`.
   */
  register(
    registration: CrmRegistration,
    ctx: CallContext,
  ): Promise<CallResult<CrmRegistrationResult>>;

  /** Attach a note to an existing record. Never creates one. */
  annotate(note: CrmNote, ctx: CallContext): Promise<CallResult<void>>;
}
