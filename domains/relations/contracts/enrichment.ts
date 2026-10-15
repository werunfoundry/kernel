/**
 * relations/contracts — enrichment: finding the people at a company, and
 * completing an identity that is missing a key (decisions 0016, 0022).
 *
 * It lives in `relations` because people and companies are this domain's
 * objects. No provider is named here (doctrine 6).
 *
 * **"Found nothing" and "could not look" are never the same answer.** A
 * search that ran and matched nobody is a success with an empty page, or with
 * `found: false`. A search that did not run — the provider was down, refused
 * the key, ran out of credit, did not understand the input — is an error.
 * Everything downstream that decides who to contact, and who not to, depends
 * on telling them apart; an adapter that turns a failure into an empty
 * result has made an outage look like a market with nobody in it.
 *
 * Four things this contract deliberately does not do, and each will look like
 * an omission:
 *
 * - **No search without a subject.** There is no "everyone who matches these
 *   criteria". Choosing whom to look at is the target list's job (0004); a
 *   criteria search here would be a second, unaudited target list.
 * - **No invented keys.** An address assembled from a name and a domain is a
 *   guess, not a key. An adapter returns only keys the provider attests; a
 *   provider that only guesses is not an enrichment source.
 * - **No verdict on a key.** Whether an address delivers is not asked here.
 * - **No persistence.** It returns keys and display fields; what is kept, and
 *   that attributes the engine does not own are not copied, is the domain's
 *   decision (doctrine 3).
 */

import type {
  Contract,
  CallContext,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey, IdentityVocabulary } from "@werunfoundry/core/identity";
import { compareIdentities, normalizeIdentity } from "@werunfoundry/core/identity";

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

/**
 * The provider looked. Either it found the subject and says what its answer
 * attests, or it did not.
 *
 * `attested` holds the keys the provider's answer itself carries, and nothing
 * else (decision 0022). A key the request carried is not copied into it: if
 * the answer does not name the profile id it was asked by, `attested` does
 * not hold that id. The difference between "the provider said so" and "we
 * told the provider" is the only evidence that the answer is about the
 * subject asked about, and copying erases it — a lookup made by a reissued
 * handle would then come back carrying the original person's id, and look
 * corroborated.
 */
export type Completion =
  | { found: false; asOf: string }
  | { found: true; attested: Identity; asOf: string };

export interface Enrichment extends Contract {
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

  /**
   * More keys for one subject. `want` names the kinds the caller is after; an
   * adapter may return others the provider attests. It returns only what the
   * provider's answer carries — never a key it was given and the answer did
   * not repeat.
   */
  complete(
    request: { identity: Identity; want?: string[] },
    ctx: CallContext,
  ): Promise<CallResult<Completion>>;
}

/**
 * What a caller does with a completion before trusting it.
 *
 * A provider can answer for the wrong subject: a common name, a stale
 * record, a handle released by one person and taken by another. The answer
 * is accepted only when it attests an immutable key of the subject asked
 * about, and none that differs — decision 0013's `same_immutable`. An answer
 * that shares only mutable keys with the request is evidence, not proof, and
 * 0013 merges nothing on evidence; an answer that shares none is the
 * provider's word alone. Either is rejected, as is one about another kind of
 * subject or one whose immutable key differs, which is someone else.
 *
 * It follows that an identity with no immutable key cannot be completed:
 * nothing a provider says could tie its answer to it.
 */
export function acceptCompletion(
  asked: Identity,
  completion: Completion,
  vocabulary: IdentityVocabulary,
): { accepted: Identity; added: IdentityKey[] } | { rejected: string } {
  if (!completion.found) return { rejected: "not found" };
  const attested = completion.attested;
  if (attested.subject !== asked.subject) {
    return { rejected: `asked about a ${asked.subject}, answered about a ${attested.subject}` };
  }
  const comparison = compareIdentities(asked, attested, vocabulary);
  if (comparison === "conflict") return { rejected: "an immutable key differs: this is someone else" };
  if (comparison !== "same_immutable") {
    return { rejected: "the answer attests no immutable key of the subject asked about: nothing ties it to them" };
  }
  const given = normalizeIdentity(asked, vocabulary);
  const back = normalizeIdentity(attested, vocabulary);
  const added = back.keys.filter(
    (b) => !given.keys.some((g) => g.kind === b.kind && (g.network ?? "") === (b.network ?? "") && g.value === b.value),
  );
  return { accepted: { subject: given.subject, keys: [...given.keys, ...added] }, added };
}
