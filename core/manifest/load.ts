/**
 * core/manifest — reading manifests off disk.
 *
 * Separate from `validate.ts` on purpose: validation is pure and can be run on
 * anything, including a document that never touched a filesystem. This file is
 * the only place in the core that knows what a file is.
 *
 * A parse failure and a validation failure come back the same way — as issues,
 * not exceptions — because a caller that is checking a whole instance wants to
 * report every problem at once, not the first one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import type {
  DomainManifest,
  InstanceManifest,
  TruthDoc,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { validateDomain, validateInstance, validateTruth } from "./validate.js";

const failed = (at: string, message: string): ValidationResult => ({
  ok: false,
  issues: [{ severity: "error", at, message }],
});

/**
 * One YAML file, parsed and not yet validated. Exported for the one caller
 * that must look inside a manifest before it can be validated: boot, which
 * learns from `enabledDomains` which domains to load before it has anything
 * to validate the manifest against.
 */
export function readDocument(file: string): { value?: unknown; result?: ValidationResult } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { result: failed(file, `cannot be read: ${(error as Error).message}`) };
  }
  try {
    return { value: parse(text) };
  } catch (error) {
    return { result: failed(file, `is not valid YAML: ${(error as Error).message}`) };
  }
}

/** Issues are reported against the file they came from, not against `(root)`. */
const locate = (file: string, r: ValidationResult): ValidationResult => ({
  ok: r.ok,
  issues: r.issues.map((i): ValidationIssue => ({ ...i, at: `${file}:${i.at}` })),
});

export function loadDomain(file: string): ValidationResult & { manifest?: DomainManifest } {
  const read = readDocument(file);
  if (read.result) return read.result;
  const validated = validateDomain(read.value);
  return { ...locate(file, validated), ...(validated.manifest ? { manifest: validated.manifest } : {}) };
}

/**
 * Every `domains/<name>/domain.yaml` under a root. A domain that fails to load
 * is reported and left out: the instance check that follows will then say what
 * depended on it, which is the more useful message.
 */
export function loadDomains(domainsDir: string): ValidationResult & { manifests: DomainManifest[] } {
  let entries: string[];
  try {
    entries = readdirSync(domainsDir).sort();
  } catch (error) {
    return { ...failed(domainsDir, `cannot be listed: ${(error as Error).message}`), manifests: [] };
  }

  const issues: ValidationIssue[] = [];
  const manifests: DomainManifest[] = [];

  for (const entry of entries) {
    const file = join(domainsDir, entry, "domain.yaml");
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue; // not a domain folder
    }
    const loaded = loadDomain(file);
    issues.push(...loaded.issues);
    if (loaded.manifest) {
      if (loaded.manifest.name !== entry) {
        issues.push({
          severity: "error",
          at: `${file}:name`,
          message: `declares "${loaded.manifest.name}" but lives in a folder named "${entry}"`,
          rule: 2,
        });
      }
      manifests.push(loaded.manifest);
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, manifests };
}

export function loadInstance(
  file: string,
  domains: readonly DomainManifest[],
): ValidationResult & { manifest?: InstanceManifest } {
  const read = readDocument(file);
  if (read.result) return read.result;
  const validated = validateInstance(read.value, domains);
  return { ...locate(file, validated), ...(validated.manifest ? { manifest: validated.manifest } : {}) };
}

/**
 * Every truth document in a directory, validated against the kinds the enabled
 * domains declare. A duplicate key is an error here rather than a last-write-
 * wins surprise later, because truths are cited by key in generated work.
 */
export function loadTruths(
  truthsDir: string,
  options: { knownKinds?: readonly string[]; staleAfterDays?: number; now?: Date } = {},
): ValidationResult & { truths: TruthDoc[] } {
  let entries: string[];
  try {
    entries = readdirSync(truthsDir).sort();
  } catch (error) {
    return { ...failed(truthsDir, `cannot be listed: ${(error as Error).message}`), truths: [] };
  }

  const issues: ValidationIssue[] = [];
  const truths: TruthDoc[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const file = join(truthsDir, entry);
    const read = readDocument(file);
    if (read.result) {
      issues.push(...read.result.issues);
      continue;
    }
    const validated = validateTruth(read.value, options);
    issues.push(...locate(file, validated).issues);
    if (!validated.truth) continue;

    const previous = seen.get(validated.truth.key);
    if (previous) {
      issues.push({
        severity: "error",
        at: `${file}:key`,
        message: `key "${validated.truth.key}" is already defined in ${previous}`,
      });
      continue;
    }
    seen.set(validated.truth.key, file);
    truths.push(validated.truth);
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues, truths };
}
