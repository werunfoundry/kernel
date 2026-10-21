/**
 * core/runtime — keyed fingerprints (decisions 0052, 0058, 0062, 0063).
 *
 * The mechanism, not its use: the core names what a fingerprint is and how
 * a version's secret is checked, and a domain decides what to fingerprint.
 * `relations` is its one user, for the register of objections that outlive
 * an erasure.
 *
 * The encoding is fixed for as long as an entry lives (0062). Changing any
 * of it — the normalisation, the separator, the order, the hash, the case of
 * the hexadecimal — makes every entry already written match nothing, as
 * surely as destroying its secret. The one reader 0055 places computes with
 * this same function, so the entries written before it exists are readable
 * the day it arrives.
 */

import { createHmac, randomBytes } from "node:crypto";

import type { IdentityKey, IdentityVocabulary } from "../identity/index.js";
import { normalizeIdentity } from "../identity/index.js";

/** A version's label: upper-case letters and digits, never renamed or reused (0058). */
export const LABEL = /^[A-Z0-9]+$/;

/** A secret, a check value, a fingerprint: 32 bytes as 64 lower-case hexadecimal characters. */
export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * What a check value is the HMAC of. It contains no NUL, and a key's
 * encoding contains two, so a check value is never an entry's fingerprint
 * (0058, §1).
 */
const CHECK_SENTENCE = "the check value of a fingerprint version (decision 0058)";

/** The variable a version's secret is read from: derived from its label, never chosen (0058). */
export const variableOf = (label: string) => `KERNEL_FINGERPRINT_${label}`;

/** 32 random bytes from the operating system's generator, as 64 hexadecimal characters (0058). */
export const generateSecret = (): string => randomBytes(32).toString("hex");

const hmac = (secret: string, data: Buffer) => createHmac("sha256", Buffer.from(secret, "hex")).update(data).digest();

/** What boot compares a secret with: a wrong value would fail open in silence (0058). */
export const checkValueOf = (secret: string): string => hmac(secret, Buffer.from(CHECK_SENTENCE, "utf8")).toString("hex");

/**
 * One key's fingerprint under one secret (0062): the key normalised as the
 * identity vocabulary compares keys (0013), its kind, network — empty when
 * it has none — and value joined by NUL, as UTF-8, under HMAC-SHA-256.
 */
export function fingerprintOf(secret: string, key: IdentityKey, vocabulary: IdentityVocabulary): string {
  const [k] = normalizeIdentity({ subject: "", keys: [key] }, vocabulary).keys;
  return hmac(secret, Buffer.from(`${k!.kind}\u0000${k!.network ?? ""}\u0000${k!.value}`, "utf8")).toString("hex");
}

/** An entry carried under the next version (0058, §3): the previous fingerprint's 32 bytes, under its secret. */
export const wrap = (secret: string, previous: string): string => hmac(secret, Buffer.from(previous, "hex")).toString("hex");

/**
 * What an erasure is handed (0062): the means to fingerprint under the
 * version that writes, and the labels whose secret the instance no longer
 * holds (0063). Never a secret.
 */
export interface Fingerprinter {
  /** The label new entries are written under: an entry's chain, never wrapped. */
  readonly writes: string;
  /** Declared versions whose variable is not set (0063). */
  readonly missing: readonly string[];
  fingerprint(key: IdentityKey): { fingerprint: string; chain: string[] };
}

export function fingerprinter(writes: string, secret: string, missing: readonly string[], vocabulary: IdentityVocabulary): Fingerprinter {
  return Object.freeze({
    writes,
    missing: Object.freeze([...missing]),
    fingerprint: (key: IdentityKey) => ({ fingerprint: fingerprintOf(secret, key, vocabulary), chain: [writes] }),
  });
}
