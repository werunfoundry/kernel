/**
 * relations/contracts — enrichment: completing an identity that is missing a
 * key (decisions 0016, 0022, 0030). Finding the people at a company is the
 * other contract, `people_source`, in `people-source.ts`.
 *
 * It lives in `relations` because people and companies are this domain's
 * objects. No provider is named here (doctrine 6).
 *
 * **"Found nothing" and "could not look" are never the same answer.** A
 * lookup that ran and matched nobody is a success with `found: false`. A
 * lookup that did not run — the provider was down, refused the key, ran out
 * of credit, did not understand the input — is an error. Everything
 * downstream that decides who to contact, and who not to, depends on telling
 * them apart; and a sequence of sources (0030) asks the next one only on the
 * first answer, never on the second.
 *
 * Three things this contract deliberately does not do, and each will look
 * like an omission:
 *
 * - **No invented keys.** An address assembled from a name and a domain is a
 *   guess, not a key. An adapter returns only keys the provider attests; a
 *   provider that only guesses is not an enrichment source.
 * - **No verdict on a key.** Whether an address delivers is not asked here.
 * - **No persistence.** It returns keys; what is kept, and that attributes
 *   the engine does not own are not copied, is the domain's decision
 *   (doctrine 3).
 */

import type {
  Contract,
  CallContext,
  CallError,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey, IdentityVocabulary } from "@werunfoundry/core/identity";
import { compareIdentities, normalizeIdentity } from "@werunfoundry/core/identity";

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
  | { found: false; asOf: string; cost?: Cost }
  | { found: true; attested: Identity; asOf: string; said?: KeyStatus[]; cost?: Cost };

/**
 * What the provider said about a key it attests, in its own words — an
 * address whose server accepts everything, for one, so that delivery cannot
 * be confirmed. Passed through, never judged: whether to send to it is the
 * sending policy's decision, not the adapter's (0016, "no verdict on a key").
 *
 * The one judgement an adapter does make is the provider's own: a key the
 * provider itself marks as wrong — an address it says is invalid — is not
 * attested, so it is not returned at all.
 */
export interface KeyStatus {
  key: IdentityKey;
  status: string;
}

/**
 * What answering cost, as the provider counts it — `{ amount: 1, unit:
 * "credits" }`. Absent when the provider does not say, never zero for
 * "unknown".
 */
export interface Cost {
  amount: number;
  unit: string;
}

/**
 * An adapter declares the key kinds it can attest in `finds` (0030): an
 * enrichment bound more than once is a sequence, and a source is asked only
 * for kinds it declared.
 */
export interface Enrichment extends Contract {
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

/** One source of a sequence, as the registry lists it (0030). */
export interface EnrichmentSource {
  adapter: Enrichment;
  /** For the record of who was asked. Never matched on. */
  provider: string;
  /** The kinds this source is asked for; it is never asked for another. */
  finds: readonly string[];
}

/** What one source was asked, and what came of it. */
export interface SequenceStep {
  provider: string;
  asked: string[];
  /**
   * `simulated`: a dry run, and the source stopped before a call it counts as
   * a write — a paid submission. The kind stays missing; nothing was learnt.
   */
  outcome: "added" | "not found" | "rejected" | "simulated";
  /** The kinds of the keys it added, when it added some. */
  added?: string[];
  /** Why the answer was not taken, when it was not. */
  rejected?: string;
  /** What the provider said about the keys it added, when it said anything. */
  said?: KeyStatus[];
  /** What the answer cost, when the provider said. */
  cost?: Cost;
}

export type SequenceResult =
  | {
      ok: true;
      /** The subject, with every key an accepted answer added. */
      identity: Identity;
      /** Kinds wanted and still missing once every source was asked. */
      missing: string[];
      steps: SequenceStep[];
    }
  | {
      ok: false;
      /** The source that could not look. The ones after it were not asked. */
      provider: string;
      error: CallError;
      steps: SequenceStep[];
    };

/**
 * Complete one subject through a sequence of sources (decision 0030).
 *
 * Each source is asked, in order, only for the wanted kinds still missing
 * that it declared it finds. A kind is missing until an answer that
 * `acceptCompletion` takes carries it. So the next source is asked when the
 * previous one looked and did not find — `found: false`, an answer without
 * that kind, or an answer the contract rejects, each recorded as a step.
 *
 * An error stops the walk, and the sources after it are not asked. A source
 * that could not look has not said the key is absent; asking the next one
 * would pay a second provider for an answer the first may hold, and return
 * something that looks complete over a failure.
 */
export async function completeInSequence(
  sources: readonly EnrichmentSource[],
  request: { identity: Identity; want: readonly string[] },
  vocabulary: IdentityVocabulary,
  ctx: CallContext,
): Promise<SequenceResult> {
  let identity = normalizeIdentity(request.identity, vocabulary);
  const missing = () => request.want.filter((kind) => !identity.keys.some((k) => k.kind === kind));
  const steps: SequenceStep[] = [];
  for (const source of sources) {
    if (missing().length === 0) break;
    const asked = missing().filter((kind) => source.finds.includes(kind));
    if (asked.length === 0) continue;
    const answer = await source.adapter.complete({ identity, want: asked }, ctx);
    if (!answer.ok) return { ok: false, provider: source.provider, error: answer.error, steps };
    const cost = answer.value.cost ? { cost: answer.value.cost } : {};
    if (answer.simulated) {
      steps.push({ provider: source.provider, asked, outcome: "simulated" });
      continue;
    }
    if (!answer.value.found) {
      steps.push({ provider: source.provider, asked, outcome: "not found", ...cost });
      continue;
    }
    const taken = acceptCompletion(identity, answer.value, vocabulary);
    if ("rejected" in taken) {
      steps.push({ provider: source.provider, asked, outcome: "rejected", rejected: taken.rejected, ...cost });
      continue;
    }
    identity = taken.accepted;
    // Only what was said about a key this answer added: a status about a key
    // the subject already had, or one the contract did not take, describes
    // nothing that is now on the identity.
    const same = (a: IdentityKey, b: IdentityKey) => a.kind === b.kind && (a.network ?? "") === (b.network ?? "") && a.value === b.value;
    const normalised = (answer.value.said ?? []).map((s) => ({ ...s, key: normalizeIdentity({ subject: identity.subject, keys: [s.key] }, vocabulary).keys[0] ?? s.key }));
    const said = normalised.filter((s) => taken.added.some((k) => same(k, s.key)));
    steps.push({
      provider: source.provider,
      asked,
      outcome: "added",
      added: [...new Set(taken.added.map((k) => k.kind))],
      ...(said.length > 0 ? { said } : {}),
      ...cost,
    });
  }
  return { ok: true, identity, missing: missing(), steps };
}
