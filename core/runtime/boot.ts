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
 * Every issue comes back at once. An instance being set up has, typically, a
 * missing credential and a domain it forgot to install and a typo in a path;
 * learning them one restart at a time is how a first afternoon is lost.
 */

import { fileURLToPath } from "node:url";
import { join, resolve as resolvePath } from "node:path";

import type { AdapterEnv } from "../contracts/types.js";
import { loadDomain, loadInstance, readDocument } from "../manifest/load.js";
import type {
  DomainManifest,
  InstanceManifest,
  ValidationIssue,
  ValidationResult,
} from "../manifest/types.js";
import { instanceManifestSchema } from "../manifest/validate.js";
import type { Registry, ResolveOptions } from "./resolve.js";
import { resolveAdapters, resolvePackage } from "./resolve.js";

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
}

/** On success, `issues` holds only warnings. On failure, every error found. */
export type BootResult = (ValidationResult & { ok: true } & Booted) | (ValidationResult & { ok: false });

/** Every domain is this package's, by construction: a domain lives in the kernel (0005). */
const DOMAIN_SCOPE = "@werunfoundry";

/** The same rule the validator applies, checked before a name becomes a path. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

const error = (at: string, message: string, rule?: number): ValidationIssue =>
  rule === undefined ? { severity: "error", at, message } : { severity: "error", at, message, rule };

/** Node's resolution failures, said in terms of what the instance should do. */
function explain(thrown: unknown, pkg: string): string {
  const code = (thrown as { code?: unknown })?.code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return `${pkg} is not installed in this instance — add it to its package.json dependencies`;
  }
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    return `${pkg} is installed but does not export ./domain.yaml, so it is not a domain this engine can load`;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return `${pkg} cannot be resolved: ${message.split("\n")[0]}`;
}

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
      issues.push(error(at, explain(thrown, pkg)));
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
  };
}
