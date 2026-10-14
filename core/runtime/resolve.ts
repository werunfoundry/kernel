/**
 * core/runtime — turning a manifest into adapters that exist.
 *
 * This is the one place where a string in a YAML file becomes a live object.
 * Everything before it is description; everything after it can make a call.
 *
 * Failures are collected, not thrown. An instance starting up wants every
 * problem at once — a missing credential and a mistyped path and an adapter
 * that forgot its default export — not the first one, fixed, then the next on
 * the following run.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import type { AdapterEnv, AdapterFactory, Contract } from "../contracts/types.js";
import type {
  InstanceManifest,
  ProviderBinding,
  ValidationIssue,
  ValidationResult,
} from "../manifest/types.js";

export interface ResolvedAdapter {
  /** The contract this satisfies, as the manifest names it. */
  contract: string;
  /** What was imported, as written in the manifest. */
  specifier: string;
  /** What the adapter calls itself. Logged, never matched on. */
  provider: string;
  adapter: Contract;
}

/**
 * Lookup is by contract name, which is a string the core never interprets —
 * `crm` means nothing here (doctrine 1). The caller knows what it asked for
 * and supplies the type.
 */
export interface Registry {
  get(contract: string): Contract | undefined;
  /**
   * For a contract the caller knows is bound, because the manifest was
   * validated. A miss is a programming error and throws, which is the one
   * case where throwing is right: no run can continue past it.
   */
  require<T extends Contract>(contract: string): T;
  list(): readonly ResolvedAdapter[];
}

export interface ResolveOptions {
  /** Directory a relative specifier is resolved against: the instance root. */
  root: string;
  /** Usually `process.env`. Injected so that a test needs no environment. */
  env: AdapterEnv;
  /**
   * Injected so that a test needs no filesystem. The default is a dynamic
   * import, which is also why resolution is asynchronous.
   */
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface ResolveResult extends ValidationResult {
  registry?: Registry;
}

const issue = (at: string, message: string): ValidationIssue => ({
  severity: "error",
  at,
  message,
});

/**
 * A relative specifier is a file in the instance; anything else is a package.
 * The distinction is Node's own, and reusing it means there is no second
 * convention for anyone to learn or for us to get subtly wrong.
 */
function locate(specifier: string, root: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return pathToFileURL(resolvePath(root, specifier)).href;
  }
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  return specifier;
}

/**
 * A package name, found where the instance installed it (decision 0007).
 *
 * Not `import(name)` from here, which is what this file did first: a bare
 * specifier resolves from the module that imports it, and this module is the
 * core, which depends on no domain and on no adapter. Under pnpm it cannot see
 * them at all. It also cannot be `import.meta.resolve(name, parent)` — the
 * second argument is ignored unless Node runs with a flag, silently.
 *
 * So the instance's own resolution, anchored at its root: the answer is the
 * one the instance would get if it had written the import itself. The anchor
 * file does not need to exist.
 *
 * Throws what Node throws. Callers turn it into an issue.
 */
export function resolvePackage(specifier: string, root: string): string {
  const require = createRequire(pathToFileURL(join(resolvePath(root), "package.json")));
  return pathToFileURL(require.resolve(specifier)).href;
}

/** `@scope/name/sub/path` → `@scope/name`; `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/**
 * Node's resolution failures, said in terms of what the instance should do.
 *
 * Shared by boot, for domains, and by the resolver, for adapters: the same
 * failure deserves the same sentence wherever it happens. Node's own wording —
 * `No "exports" main defined` — blames the package, when the cause is how this
 * engine resolves (decision 0007), and the remedy is written in a decision
 * nobody is reading at the moment the error appears. So the remedy is here.
 *
 * Only failures of resolving a package name are translated. Anything else —
 * a relative file that is missing, a module that throws while loading — keeps
 * Node's first line, which is already the right one.
 */
export function explainResolution(thrown: unknown, specifier: string): string {
  const code = (thrown as { code?: unknown })?.code;
  const message = (thrown instanceof Error ? thrown.message : String(thrown)).split("\n")[0] ?? "";
  const bare = !specifier.startsWith(".") && !isAbsolute(specifier) && !specifier.startsWith("file:");
  if (!bare) return message;

  const pkg = packageOf(specifier);
  if (code === "MODULE_NOT_FOUND") {
    return `${pkg} is not installed in this instance — add it to its package.json dependencies`;
  }
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    const what = specifier === pkg ? "its main entry" : `"./${specifier.slice(pkg.length + 1)}"`;
    return (
      `${pkg} is installed, but exports nothing for ${what} under the "require" or "default" condition, ` +
      `which is how the engine resolves a package from the instance (decision 0007). ` +
      `If it exports that path only under "import", add a "default" key beside "import" in its exports`
    );
  }
  return `${pkg} cannot be resolved: ${message}`;
}

/**
 * The variables this binding declared, and only those.
 *
 * An adapter is handed its credentials rather than reaching for them, so that
 * reading a manifest tells you exactly what each adapter can see. A variable
 * that is declared and absent fails here, at startup, rather than inside the
 * first call where it would look like the provider was down.
 */
function envFor(binding: ProviderBinding, env: AdapterEnv, at: string): {
  env: AdapterEnv;
  issues: ValidationIssue[];
} {
  const subset: Record<string, string | undefined> = {};
  const issues: ValidationIssue[] = [];
  for (const name of binding.env) {
    const value = env[name];
    if (value === undefined || value === "") {
      issues.push(issue(`${at}.env`, `${name} is declared but not set`));
      continue;
    }
    subset[name] = value;
  }
  return { env: Object.freeze(subset), issues };
}

async function build(
  binding: ProviderBinding,
  index: number,
  options: ResolveOptions,
): Promise<{ resolved?: ResolvedAdapter; issues: ValidationIssue[] }> {
  const at = `providers.${index}`;
  const importModule =
    options.importModule ??
    ((s: string) => import(s.startsWith("file:") ? s : resolvePackage(s, options.root)));

  const { env, issues } = envFor(binding, options.env, at);
  if (issues.length > 0) return { issues };

  let module: unknown;
  try {
    module = await importModule(locate(binding.adapter, options.root));
  } catch (error) {
    return { issues: [issue(`${at}.adapter`, `cannot be loaded: ${explainResolution(error, binding.adapter)}`)] };
  }

  const factory = (module as { default?: unknown })?.default;
  if (typeof factory !== "function") {
    return {
      issues: [
        issue(
          `${at}.adapter`,
          "must export a factory as its default export — see an adapter's README",
        ),
      ],
    };
  }

  let adapter: unknown;
  try {
    adapter = (factory as AdapterFactory<Contract>)({
      options: Object.freeze({ ...binding.options }),
      env,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // Doctrine: build nothing in a factory that can fail. When one does
    // anyway, it fails here rather than halfway through a run.
    return { issues: [issue(`${at}.adapter`, `failed to build: ${why}`)] };
  }

  const provider = (adapter as { provider?: unknown })?.provider;
  if (typeof provider !== "string" || provider === "") {
    return {
      issues: [issue(`${at}.adapter`, "built something that does not name its provider")],
    };
  }

  return {
    issues: [],
    resolved: {
      contract: binding.contract,
      specifier: binding.adapter,
      provider,
      adapter: adapter as Contract,
    },
  };
}

/**
 * Build every adapter the manifest binds.
 *
 * The manifest is assumed validated: `validateInstance` has already refused a
 * contract bound twice or a domain enabled without its dependencies. What is
 * checked here is only what cannot be known without reaching for the module.
 */
export async function resolveAdapters(
  manifest: InstanceManifest,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const issues: ValidationIssue[] = [];
  const resolved: ResolvedAdapter[] = [];

  const built = await Promise.all(
    manifest.providers.map((binding, index) => build(binding, index, options)),
  );

  for (const result of built) {
    issues.push(...result.issues);
    if (result.resolved) resolved.push(result.resolved);
  }

  if (issues.some((i) => i.severity === "error")) return { ok: false, issues };

  const byContract = new Map(resolved.map((r) => [r.contract, r]));

  return {
    ok: true,
    issues,
    registry: {
      get: (contract) => byContract.get(contract)?.adapter,
      require<T extends Contract>(contract: string): T {
        const found = byContract.get(contract);
        if (!found) {
          throw new Error(
            `no adapter is bound to the contract "${contract}" — the manifest enables it or it does not exist`,
          );
        }
        return found.adapter as T;
      },
      list: () => resolved,
    },
  };
}
