# 0007 — A name in the manifest resolves from the instance

> Completed by [0046](0046-the-addressing-domain-is-acquisition.md): the domain
> called `gtm` here is `acquisition`; read `gtm.x` as `acquisition.x`.

## Decided

Every name an instance manifest holds is resolved the way the instance would
resolve it if it had written the import itself: from the instance root, with
the instance's own `node_modules`.

- An enabled domain `x` is the package `@werunfoundry/x`. Boot reads its
  `domain.yaml` through the package's exports, as
  `@werunfoundry/x/domain.yaml`. Every domain exports that path, and
  `scripts/check.mjs` refuses one that does not.
- A provider binding that names a package is found the same way. A relative
  path was already resolved against the instance root; now both shapes are.

The mechanism is Node's own resolution anchored at the instance root —
`createRequire(<root>/package.json).resolve(name)` — in one function,
`resolvePackage` in `core/runtime/resolve.ts`, used by both.

## Why

Boot has to read the `domain.yaml` of each enabled domain, and in an installed
instance those files live in `node_modules/@werunfoundry/<name>/`. Three ways
to find them were tried, by running them, not by reading about them.

**`import.meta.resolve(name)` from the core.** It resolves from the module
that calls it, which is the core — and the core depends on no domain
(doctrine 2), so under pnpm it cannot see them. `ERR_MODULE_NOT_FOUND`. The
two-argument form, `import.meta.resolve(name, parent)`, would be the right
tool, and Node ignores the second argument unless it runs with
`--experimental-import-meta-resolve`. Ignores it silently: the call returns
the same failure as the one-argument form.

**Reading a directory.** `loadDomains` lists `domains/*/domain.yaml`, which
is right inside this repository and means nothing in an instance, where the
folder is `node_modules`, its layout is the package manager's business, and
everything installed there is not enabled.

**Resolving from the instance.** Works, and answers the question that matters:
is this domain installed *in this instance*. A domain that is not gets a
message saying which dependency to add.

The same probe found that the binding resolver had the first defect already.
It handed a package specifier to `import()` inside `core/runtime/resolve.ts`,
so a published adapter could never be loaded from an instance. Its tests
passed because they inject the importer. The rule is one rule — a name in the
manifest is the instance's name — so it is fixed here, with a test that
injects nothing.

## What this costs

**Every enabled domain is a direct dependency of the instance.** `gtm`
depends on `relations`; pnpm installs `relations` for `gtm` and does not
expose it to the instance. Since enabling `gtm` already requires enabling
`relations`, the instance lists both. Explicit, and one more line.

**`domain.yaml` becomes published surface.** It was a file the checks read;
it is now part of what each domain package promises. When the build of
decision 0006 is wired, `publishConfig.exports` must keep it.

**Require conditions, not import conditions.** `createRequire` matches a
package's exports under `require` and `default`. A plain string target — what
every package here uses — matches. A package that exports only under
`import` does not resolve, and boot says it cannot be loaded. For an adapter
published elsewhere that is a real constraint, and the remedy is one
`default` key in its exports.

## Rules out

- A domain outside the `@werunfoundry` scope. Domains live in the kernel
  (0005); a name in `enabledDomains` is not a path and not a package name.
- Scanning `node_modules` for whatever happens to be installed.
- Resolving anything an instance names from the engine's own location.

## Would reverse it

Node accepting a parent in `import.meta.resolve` without a flag. That gives
ESM conditions, removes the `require` caveat, and changes one function.
