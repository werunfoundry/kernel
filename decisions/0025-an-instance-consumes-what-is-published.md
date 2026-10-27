# 0025 — An instance consumes what is published

> Completed by [0073](0073-a-merge-publishes-the-commit-it-names.md): a merge
> to main publishes the five packages as `0.1.0-main.g` and the commit.

Completes [0008](0008-the-build-now-and-no-loader-anywhere.md), which wired
the build and ruled out a loader in an instance, and rests on
[0006](0006-the-published-artifact-is-javascript.md) and
[0007](0007-names-resolve-from-the-instance.md).

## Decided

An instance depends on the engine in one of two forms, and only these:

- **a published version**, `"@werunfoundry/core": "^0.1.0"`, once the
  packages are on the registry;
- **a packed tarball**, `"file:…/werunfoundry-core-0.1.0.tgz"`, made by
  `pnpm pack` from a checkout of this repository — before publication, or to
  try a change before it is published.

**Never a folder.** Not `file:../kernel/core`, not `link:`, `portal:` or
`workspace:`. `kernel-check-instance` refuses one, in the dependencies and in
the overrides, and names this decision.

## Why

`pnpm pack` is the publication without the upload. It applies
`publishConfig` — the exports and commands that point at `dist/` (0006) —
rebuilds `dist/` from scratch in `prepack` (0008), and replaces `workspace:*`
with versions. A tarball is therefore exactly the artifact 0006 and 0008
decided, byte for byte what a publish would upload; installing one is not a
workaround for the registry, it is the same thing from a different place.

A folder is the workspace's view of a package, not the published one. pnpm
installs it by its `files` and applies none of the above, and the first
instance generated beside this repository found each consequence in turn:

- `workspace:*` dependencies, which mean nothing outside the workspace, stop
  the install;
- `exports` still point at TypeScript source, which the folder's `files` do
  not even ship, so a name resolved from the instance (0007) finds nothing;
- the commands are `.ts` under `node_modules`, which Node refuses to run
  (0006);
- `dist/`, when a local build happens to have left one, is reachable by path
  but not by name: one package's compiled code imports another by its
  package name, and lands back on the missing source.

A link to the source fares no better: the source imports `./x.js`, which only
exists once compiled (0006). Every one of these is a contradiction of 0006 or
0008, not a gap in them, so making folders work would mean undoing what they
decided.

## Rules out

- **Compiling at install.** No `prepare` or `postinstall` that builds the
  engine in the instance: the instance installs JavaScript, it does not make
  it.
- **A loader in the instance**, to run source it was handed instead (0008
  already; this closes the route by which one would come back).
- **A second set of exports** for folder consumers. One package has one
  published shape.

## What this costs

Trying a change to the engine in an instance means packing first:
`pnpm pack` in each package changed, then installing the tarballs.
`scripts/try-instance.mjs` does exactly this, and the template's README says
how by hand. A few seconds per package, for a guarantee that what was tried
is what will ship.

## Would reverse it

Node running TypeScript under `node_modules`, and resolving `./x.js` to
`x.ts`. Then the source would be a valid artifact and 0006 itself would be
up for review, with this.
