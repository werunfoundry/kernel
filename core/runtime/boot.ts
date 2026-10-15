/**
 * core/runtime — starting an instance.
 *
 * Boot is the moment description becomes something that can run: the domains
 * an instance enables are found and read, its manifest is validated against
 * them, and every binding is turned into an adapter. It touches no database.
 * Boot is the start, not a run — a run is opened afterwards by whatever the
 * instance was started to do, and a configuration that cannot boot never gets
 * as far as writing a row about itself.
 *
 * It does not load truths. Boot answers one question — can this system run —
 * and a truth nobody has confirmed lately must not stop a run from being
 * recorded. Truths are loaded by `verify`, and by each process where it uses
 * them.
 *
 * Every issue comes back at once. An instance being set up has, typically, a
 * missing credential and a domain it forgot to install and a typo in a path;
 * learning them one restart at a time is how a first afternoon is lost.
 */

import { fileURLToPath } from "node:url";
import { join, resolve as resolvePath } from "node:path";

import type { AdapterEnv } from "../contracts/types.js";
import type { IdentityVocabulary } from "../identity/index.js";
import { identityVocabulary } from "../identity/index.js";
import { loadDomain, loadInstance, readDocument } from "../manifest/load.js";
import type {
  DomainManifest,
  InstanceManifest,
  ValidationIssue,
  ValidationResult,
} from "../manifest/types.js";
import { instanceManifestSchema } from "../manifest/validate.js";
import type { Registry, ResolveOptions } from "./resolve.js";
import { explainResolution, resolveAdapters, resolvePackage } from "./resolve.js";

export interface BootOptions {
  /**
   * The instance root: where its manifest lives, and where its packages are
   * installed. Every name in the manifest is resolved from here (0007).
   */
  root: string;
  /** Usually `process.env`. Injected so that a test needs no environment. */
  env: AdapterEnv;
  /** Relative to `root`. */
  manifest?: string;
  /** Passed to the resolver; see `ResolveOptions`. */
  importModule?: ResolveOptions["importModule"];
}

export interface Booted {
  manifest: InstanceManifest;
  /** In the order the manifest enables them. */
  domains: DomainManifest[];
  registry: Registry;
  /** The identity keys and subjects the enabled domains declare, and the instance's networks (0013). */
  identity: IdentityVocabulary;
}

/** On success, `issues` holds only warnings. On failure, every error found. */
export type BootResult = (ValidationResult & { ok: true } & Booted) | (ValidationResult & { ok: false });

/** Every domain is this package's, by construction: a domain lives in the kernel (0005). */
const DOMAIN_SCOPE = "@werunfoundry";

/** The same rule the validator applies, checked before a name becomes a path. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const error = (at: string, message: string, rule?: number): ValidationIssue =>
  rule === undefined ? { severity: "error", at, message } : { severity: "error", at, message, rule };

/**
 * Each enabled name, as the instance installed it.
 *
 * Returned with the indices that failed, so that the validator's own "no
 * domain named" for the same entry can be dropped: one cause, one issue, and
 * the one kept is the one that says what to do.
 */
function loadEnabled(
  names: readonly unknown[],
  root: string,
  file: string,
): { domains: DomainManifest[]; issues: ValidationIssue[]; failed: Set<string> } {
  const domains: DomainManifest[] = [];
  const issues: ValidationIssue[] = [];
  const failed = new Set<string>();

  for (const [i, name] of names.entries()) {
    const at = `${file}:enabledDomains.${i}`;
    // Not an identifier: the validator says so, in its own words.
    if (typeof name !== "string" || !IDENTIFIER.test(name)) continue;

    const pkg = `${DOMAIN_SCOPE}/${name}`;
    let path: string;
    try {
      path = fileURLToPath(resolvePackage(`${pkg}/domain.yaml`, root));
    } catch (thrown) {
      issues.push(error(at, explainResolution(thrown, `${pkg}/domain.yaml`)));
      failed.add(at);
      continue;
    }

    const loaded = loadDomain(path);
    issues.push(...loaded.issues);
    if (!loaded.manifest) {
      failed.add(at);
      continue;
    }
    if (loaded.manifest.name !== name) {
      issues.push(error(at, `${pkg} declares itself "${loaded.manifest.name}" in its domain.yaml`, 2));
      failed.add(at);
      continue;
    }
    domains.push(loaded.manifest);
  }

  return { domains, issues, failed };
}

export async function boot(options: BootOptions): Promise<BootResult> {
  const root = resolvePath(options.root);
  const file = join(root, options.manifest ?? "manifest.yaml");

  const read = readDocument(file);
  if (read.result) return { ok: false, issues: read.result.issues };

  // Looked at before validation, because validation needs the domains and
  // the manifest is the only thing that says which ones. Whatever is not a
  // list here is reported by the validator below.
  const enabled = (read.value as { enabledDomains?: unknown } | null)?.enabledDomains;
  const loaded = loadEnabled(Array.isArray(enabled) ? enabled : [], root, file);

  const validated = loadInstance(file, loaded.domains);
  const issues = [
    ...loaded.issues,
    ...validated.issues.filter((i) => !loaded.failed.has(i.at)),
  ];

  // Bindings are resolved whenever the manifest has the right shape, even if
  // a cross-check failed: a missing credential is worth knowing about on the
  // same run as a missing domain.
  const shaped = instanceManifestSchema.safeParse(read.value);
  const resolved = shaped.success
    ? await resolveAdapters(shaped.data, {
        root,
        env: options.env,
        ...(options.importModule ? { importModule: options.importModule } : {}),
      })
    : undefined;
  if (resolved) issues.push(...resolved.issues.map((i) => ({ ...i, at: `${file}:${i.at}` })));

  // So is a metric a source says it can read (decision 0018).
  const metricKeys = new Set(loaded.domains.flatMap((d) => (d.metrics ?? []).map((m) => m.key)));
  for (const r of resolved?.registry?.list() ?? []) {
    const reads = (r.adapter as { metrics?: unknown }).metrics;
    if (!Array.isArray(reads)) continue;
    for (const key of reads) {
      if (!metricKeys.has(key)) {
        issues.push(error(`${file}:providers.${r.index}`, `this source reads "${String(key)}", which no enabled domain declares`, 1));
      }
    }
  }

  // A channel an adapter declares for itself is vocabulary like any other:
  // one no enabled domain declares is refused (decision 0015).
  const channels = new Set(loaded.domains.flatMap((d) => d.channels ?? []));
  for (const r of resolved?.registry?.list() ?? []) {
    for (const channel of r.channels) {
      if (!channels.has(channel)) {
        issues.push(error(`${file}:providers.${r.index}.channels`, `no enabled domain declares the channel "${channel}"`, 1));
      }
    }
  }

  // So is a key kind an adapter says it finds (decision 0030): asking a
  // source for a kind nobody declared would hand back keys nothing can read.
  const kinds = new Set(loaded.domains.flatMap((d) => (d.identityKeys ?? []).map((k) => k.kind)));
  for (const r of resolved?.registry?.list() ?? []) {
    for (const kind of r.finds) {
      if (!kinds.has(kind)) {
        issues.push(error(`${file}:providers.${r.index}.finds`, `no enabled domain declares the identity key "${kind}"`, 1));
      }
    }
  }

  if (issues.some((i) => i.severity === "error") || !validated.manifest || !resolved?.registry) {
    // A failure with no error in it would be a bug here, and an empty report
    // is the worst way to show one.
    if (!issues.some((i) => i.severity === "error")) issues.push(error(file, "did not boot, for no stated reason"));
    return { ok: false, issues };
  }

  return {
    ok: true,
    issues,
    manifest: validated.manifest,
    domains: loaded.domains,
    registry: resolved.registry,
    identity: identityVocabulary(loaded.domains, validated.manifest.networks ?? []),
  };
}
