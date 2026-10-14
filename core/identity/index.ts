/**
 * core/identity — what something is called, in every system that calls it
 * something (decision 0013).
 *
 * An identity is a set of keys for one subject. The core knows the mechanism
 * and nothing else: which *subjects* exist (a person, a company) and which
 * *kinds* of key name them (an address, a domain, a profile id) are vocabulary
 * that domains declare in their `domain.yaml`, the way they declare channels.
 * The core contains no business word (doctrine 1); a domain that needs to say
 * "person" says it in its own manifest.
 *
 * Networks — which social network a profile id belongs to — are declared by
 * the instance, in its manifest, because naming one names a provider, and a
 * provider is named only where the instance or an adapter names it
 * (doctrine 6).
 *
 * There is no resolution here: nothing merges two identities, nothing looks
 * one up. `compareIdentities` says what two identities' keys imply, and the
 * caller decides what to do with it.
 */

import type { DomainManifest, IdentityKeyKind, ValidationIssue } from "../manifest/types.js";

export type { IdentityKeyKind };

/** One name for a subject, in one system. */
export interface IdentityKey {
  /** Declared by a domain in `identityKeys`. */
  kind: string;
  value: string;
  /** Required for a networked kind, refused for any other; declared by the instance. */
  network?: string;
}

export interface Identity {
  /** Declared by a domain as the `subject` of one of its key kinds. */
  subject: string;
  keys: IdentityKey[];
}

export interface IdentityVocabulary {
  kinds: ReadonlyMap<string, IdentityKeyKind>;
  subjects: ReadonlySet<string>;
  networks: ReadonlySet<string>;
}

/**
 * The union of what the enabled domains declare, and the instance's networks.
 * A kind declared by two domains is refused at validation, before this runs:
 * two domains needing the same key is the signal it belongs one layer down.
 */
export function identityVocabulary(
  domains: readonly DomainManifest[],
  networks: readonly string[] = [],
): IdentityVocabulary {
  const kinds = new Map<string, IdentityKeyKind>();
  for (const d of domains) for (const k of d.identityKeys ?? []) kinds.set(k.kind, k);
  return {
    kinds,
    subjects: new Set([...kinds.values()].map((k) => k.subject)),
    networks: new Set(networks),
  };
}

const keyOf = (k: IdentityKey) => `${k.kind}\u0000${k.network ?? ""}`;

/**
 * Trimmed, lower-cased where the kind says case means nothing, and without
 * duplicate keys. Two identities are compared only in this form.
 */
export function normalizeIdentity(identity: Identity, vocabulary: IdentityVocabulary): Identity {
  const seen = new Set<string>();
  const keys: IdentityKey[] = [];
  for (const key of identity.keys) {
    const kind = vocabulary.kinds.get(key.kind);
    const value = kind?.caseInsensitive ? key.value.trim().toLowerCase() : key.value.trim();
    const normalized: IdentityKey = key.network === undefined
      ? { kind: key.kind, value }
      : { kind: key.kind, value, network: key.network };
    const id = `${keyOf(normalized)}\u0000${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(normalized);
  }
  return { subject: identity.subject, keys };
}

/**
 * Everything wrong with an identity, at once. An undeclared kind, subject or
 * network is refused rather than carried: two adapters writing the same
 * network two ways would leave two identities that never meet again.
 */
export function checkIdentity(identity: Identity, vocabulary: IdentityVocabulary): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (at: string, message: string) => issues.push({ severity: "error", at, message });

  if (!vocabulary.subjects.has(identity.subject)) {
    error("subject", `no enabled domain declares the subject "${identity.subject}"`);
  }
  if (identity.keys.length === 0) error("keys", "an identity with no key names nothing");

  for (const [i, key] of identity.keys.entries()) {
    const at = `keys.${i}`;
    const kind = vocabulary.kinds.get(key.kind);
    if (!kind) {
      error(`${at}.kind`, `no enabled domain declares the identity key "${key.kind}"`);
      continue;
    }
    if (kind.subject !== identity.subject) {
      error(`${at}.kind`, `"${key.kind}" names a ${kind.subject}, not a ${identity.subject}`);
    }
    if (key.value.trim() === "") error(`${at}.value`, "empty");
    if (kind.networked) {
      if (key.network === undefined) error(`${at}.network`, `"${key.kind}" needs a network`);
      else if (!vocabulary.networks.has(key.network)) {
        error(`${at}.network`, `the instance declares no network "${key.network}"`);
      }
    } else if (key.network !== undefined) {
      error(`${at}.network`, `"${key.kind}" is not tied to a network`);
    }
  }
  return issues;
}

/**
 * What two identities' keys imply, and on what evidence.
 *
 * - `conflict`: an immutable key of the same kind and network is present in
 *   both, with different values. Immutable keys are authoritative, so this
 *   holds even if a mutable key — an address, a domain — matches.
 * - `same_immutable`: they share an immutable key and none conflicts.
 * - `same_mutable`: they share only mutable keys. An address can be reissued
 *   and a domain sold, so this is evidence, not proof. Protection treats it as
 *   the same subject — over-protecting is the safe mistake — and nothing
 *   merges on it.
 * - `unknown`: different subjects, or no key in common.
 */
export type IdentityComparison = "conflict" | "same_immutable" | "same_mutable" | "unknown";

export function compareIdentities(a: Identity, b: Identity, vocabulary: IdentityVocabulary): IdentityComparison {
  if (a.subject !== b.subject) return "unknown";
  const x = normalizeIdentity(a, vocabulary);
  const y = normalizeIdentity(b, vocabulary);

  let sameImmutable = false;
  let sameMutable = false;
  for (const kx of x.keys) {
    const kind = vocabulary.kinds.get(kx.kind);
    for (const ky of y.keys) {
      if (keyOf(kx) !== keyOf(ky)) continue;
      const equal = kx.value === ky.value;
      if (kind?.immutable) {
        if (!equal) return "conflict";
        sameImmutable = true;
      } else if (equal) {
        sameMutable = true;
      }
    }
  }
  if (sameImmutable) return "same_immutable";
  if (sameMutable) return "same_mutable";
  return "unknown";
}

/** The values of one kind of key, for an adapter that reaches people by it. */
export function keysOfKind(identity: Identity, kind: string): string[] {
  return identity.keys.filter((k) => k.kind === kind).map((k) => k.value);
}
