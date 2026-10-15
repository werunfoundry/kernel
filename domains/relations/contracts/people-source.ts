/**
 * relations/contracts — people source: finding the people at a company
 * (decisions 0016, 0030).
 *
 * Split from enrichment by 0030. Finding people and completing an identity
 * are two capabilities, and the providers that offer them differ; one module
 * that offers both is bound once under each name. A people source is bound
 * once: two would be two lists of whom to contact.
 *
 * **"Found nothing" and "could not look" are never the same answer.** A
 * search that ran and matched nobody is a success with an empty page. A
 * search that did not run — provider down, key refused, credit exhausted,
 * input not understood — is an error. An adapter that turns a failure into
 * an empty page has made an outage look like a market with nobody in it.
 *
 * **No search without a subject.** There is no "everyone who matches these
 * criteria". Choosing whom to look at is the target list's job (0004); a
 * criteria search here would be a second, unaudited target list.
 *
 * No provider is named here (doctrine 6).
 */

import type { CallContext, CallResult, Contract } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";

/** A person the provider attests works at the company asked about. */
export interface FoundPerson {
  /** Subject `person`, with at least one key the provider attests. */
  identity: Identity;
  /** For humans and templates. Never used for matching, never a key. */
  display?: { fullName?: string; title?: string };
}

export interface PeoplePage {
  /** Empty means the search ran and found nobody — not that it failed. */
  items: FoundPerson[];
  /** Absent means this was the last page. Opaque; never parsed. */
  nextCursor?: string;
  /** When the provider's data is from, as it says — not when we asked. */
  asOf: string;
}

export interface PeopleSource extends Contract {
  /**
   * The people at one company, a page at a time. `company` is an identity of
   * subject `company`; an adapter that recognises none of its keys refuses
   * as `invalid` rather than answering for a company it did not identify.
   */
  peopleAt(
    request: {
      company: Identity;
      limit?: number;
      cursor?: string;
      /** Values the instance declared, passed through untouched — roles, seniority. */
      params?: Record<string, string | number | boolean>;
    },
    ctx: CallContext,
  ): Promise<CallResult<PeoplePage>>;
}
