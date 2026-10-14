# 0008 — The build now, and no loader anywhere

Completes [0006](0006-the-published-artifact-is-javascript.md), which decided
*what* is published — compiled JavaScript and declarations — and stands
entirely. This decides *when*, and how the instance side runs.

## Decided

**The build is wired now.** Each package compiles to `dist/` with
`tsc -b tsconfig.build.json`. `publishConfig.exports` points every export at
`dist/` and keeps `./domain.yaml` (0007). `prepack` deletes `dist/` and builds
again, so a pack never carries yesterday's output. The packages are no longer
private, and are versioned `0.1.0`.

**The instance runs its own TypeScript on plain Node.** Node refuses to strip
types under `node_modules`, not in a project's own files. The kernel is
JavaScript by the time it reaches an instance; the instance's adapters and
scripts are TypeScript Node runs directly, from 22.18. So:

- an instance writes its relative imports as `./x.ts`, the file's real name;
- its `tsconfig.json` keeps `allowImportingTsExtensions` — the kernel dropped
  it because it emits, an instance keeps it because it never does;
- `erasableSyntaxOnly` refuses at typecheck the syntax stripping cannot
  remove: enums, namespaces, constructor parameter properties.

**`tsx` leaves the template.** It stays a development dependency of the
kernel's workspace, for its tests, and is never something an instance needs.

## What this corrects

0006 ruled out "requiring a loader in order to use the engine". The template
then ran `verify` through `tsx`, because the packages it consumed were still
source. That exclusion was not true when it was written; it is true from here.

## How it is known to work

Inside the workspace the packages are source, reached through links, with a
loader in the tests — three things no instance has. So passing there proves
nothing about an instance. `scripts/try-instance.mjs`, run in CI, packs every
package, generates an instance outside the workspace, installs the tarballs,
applies the migrations the packages ship to a real database, runs the
instance's own check, and runs `verify` with `node` and nothing else. It fails
unless a run was opened, the provider was called with its id, and the run was
closed as succeeded.

It was checked by planting the failure it exists for: a published export
pointing at a file `dist` does not contain passes every doctrine check, and
fails there.

## What this costs

**Two lists of exports.** The workspace reads `exports`, the published
package reads `publishConfig.exports`. `scripts/check.mjs` refuses them
listing different paths, and refuses a published target that is TypeScript.

**The template cannot run inside the kernel's workspace.** Its `verify`
imports the kernel, which is source there. `pnpm try-instance` is how it runs
from here; the template's own `pnpm verify` is for the instance it becomes.

**A floor on Node.** 22.18, the first 22.x that strips types without a flag.

**Not on the registry yet.** Publishing needs the `@werunfoundry` scope to
exist there, which is an account, not code. Until then an instance cannot
install `^0.1.0`; the packs are proven, the publication is pending.

## Rules out

- A loader in an instance, for any script.
- Publishing from a `dist/` that `prepack` did not just rebuild.
- An instance writing `./x.js` for a file named `x.ts`.

## Would reverse it

An instance that needs syntax stripping cannot remove — a decorator-based
library, say — would need a build or a loader of its own. That is a choice for
that instance, and this decision only stops the kernel from making it for
everyone.
