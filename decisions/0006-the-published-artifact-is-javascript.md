# 0006 — What gets published is JavaScript

> Completed by [0008](0008-the-build-now-and-no-loader-anywhere.md): when the
> build lands, and how the instance side runs.

## Decided

The engine's packages publish compiled JavaScript and `.d.ts` declarations.
They do not publish TypeScript source.

The workspace keeps consuming source: `tsc` maps a `./x.js` specifier back to
`x.ts` without complaint, so typechecking needs no build. Only the published
artifact is compiled, which `publishConfig.exports` swaps in at publish time.

Running the source is a different matter, and this decision costs something
there. Node's type stripping does not rewrite a `.js` specifier to a `.ts`
file — verified, not assumed:

```
import { value } from "./dep.js";   // only dep.ts exists
ERR_MODULE_NOT_FOUND
```

So from the moment the specifiers changed, the source stopped being runnable
by plain Node. Tests and scripts go through `tsx`, a development dependency
that does the rewrite and is never published. The alternative was to add the
build immediately and run everything against `dist`, which buys nothing today
and makes every edit wait for a compile.

Taken now; the build itself is added when the first instance has to run. What
is done now is the part that gets expensive later: relative imports are
written `./x.js`, and `allowImportingTsExtensions` is gone.

## Why

Not for speed, and the record should be precise about this because the
measurement is easy to misread. Node starts in 58 ms against compiled
JavaScript and 470 ms against TypeScript through a loader — eight times, but
eight times a *process start*. This engine spends its real time in HTTP calls
to providers and in database round trips, measured in hundreds of milliseconds
each. The startup difference is a rounding error beside one call to a CRM, and
anyone who buys this decision for throughput will go looking for a gain that
is not there.

The reason is interoperability, and it is not a matter of degree. Node refuses
to transform TypeScript under `node_modules` — deliberately, type stripping is
for a project's own source, not its dependencies:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

The flag does not change it. A package that publishes `.ts` therefore cannot
be used by plain Node at all. A loader such as `tsx` lifts the restriction,
but that means every instance carries an extra dependency and a loader in
every entry point, and that the engine stops working the moment someone runs
it any other way. Publishing source is choosing your consumers' runtime for
them.

## Why the import specifiers change today

`allowImportingTsExtensions` is what let `./db/schema.ts` be written as an
import, and TypeScript only permits it under `noEmit`. Emitting anything
requires removing it and writing `./db/schema.js` — the ordinary ESM
convention, where the specifier names the output rather than the input.

Nineteen specifiers across a dozen files today. The same change once external
adapters exist is a change to code this repository does not own.

## What this costs

**A build is a new way to fail.** A stale `dist` in CI, a publish that ships
yesterday, source maps wired badly enough that every stack trace points at a
generated line nobody can read. Boring, and real.

**It commits to publishing.** Compiled output and declarations only pay for
themselves if the packages go somewhere. The alternative — instances depending
on a git revision with a `prepare` script that builds on install — would work
and skip a registry entirely. It is rejected because decision 0005 made the
contracts a surface other people implement, and a git tag is a poor substitute
for a version.

**A small, permanent wart.** `from "./db/schema.js"` in a file named
`schema.ts` is the universal TypeScript convention and it still reads wrong to
anyone meeting it for the first time, in a repository meant to be legible to
people who do not write backends.

## Rules out

- Publishing TypeScript source and expecting consumers to deal with it.
- Requiring a loader in order to use the engine.
- A build step that the workspace has to run before editing.

## Would reverse it

Node lifting the `node_modules` restriction, which would make publishing
source viable for plain consumers. That is the one change that would matter,
and it is theirs to make, not ours.
