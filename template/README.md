# An instance

This folder is the skeleton. An instance is a copy of it, in its own private
repository, that depends on the engine as a pinned package.

It is not a fork. Nothing here is engine code, and nothing here should ever
become engine code — when something in an instance starts to look generic,
that is the signal it belongs in a domain.

## What is yours

```
manifest.yaml       what this instance is, and what satisfies each contract
.env.example        the names of every credential — never a value
adapters/           the one place code lives here
truths/             the claims you stand behind, machine half and prose half
context/            prose the engine may cite and will never parse
```

## Your TypeScript runs as it is

An instance has no build. Node runs its TypeScript directly, by stripping the
types — Node 22.18 or later, no loader, no flag (decision 0008). Two things
follow:

- **Relative imports name the file**: `./mapping.ts`, not `./mapping.js`.
  Node finds a file by the name it has.
- **Only syntax that can be erased.** No enums, no namespaces, no constructor
  parameter properties: stripping cannot remove them, and they would fail at
  run time. `erasableSyntaxOnly` in `tsconfig.json` refuses them at typecheck
  instead. It exists from TypeScript 5.8, which is why `package.json` asks
  for `typescript` 5.8 or later, beside `@types/node` for the Node floor;
  `pnpm typecheck` uses those, not whatever `tsc` the machine has.

## How this instance gets the engine

As a published version, or as a packed tarball — never as a folder
(decision 0025). A tarball is what a publish would upload: `pnpm pack`
applies the package's `publishConfig` and rebuilds its JavaScript, which a
folder path skips, and an instance installed from a folder fails at its first
command.

Until the packages are on the registry, or to try a change to the engine
before it is published, pack them from a checkout of the engine:

```
mkdir -p ../packs
(cd ../kernel/core              && pnpm pack --pack-destination ../../packs)
(cd ../kernel/domains/relations && pnpm pack --pack-destination ../../../packs)
(cd ../kernel/domains/acquisition       && pnpm pack --pack-destination ../../../packs)
```

and point the dependencies at the tarballs, here and in the overrides (one
engine package depends on another, and pnpm must take that one from the
tarball too):

```json
"dependencies": { "@werunfoundry/core": "file:../packs/werunfoundry-core-0.1.0.tgz" }
```

```yaml
# pnpm-workspace.yaml
overrides:
  "@werunfoundry/core": "file:../packs/werunfoundry-core-0.1.0.tgz"
```

The same for `relations` and `acquisition`, and for `@werunfoundry/adapters` if a
binding names a shipped adapter. `pnpm check` refuses a folder.

## Starting one

```
node scripts/new-instance.mjs ../my-instance
cd ../my-instance && git init && pnpm install
```

It runs as it is. Every contract is bound to a sandbox adapter that answers
from invented data, so before anything is configured:

```
cp .env.example .env          # set DATABASE_URL (and DIRECT_URL, for migrations)
pnpm migrate                  # installs core, relations, acquisition — in that order
pnpm verify                   # boots, opens a dry run, probes every adapter
pnpm source -- --max-age 60 --max-people 10 --want email
```

`pnpm source` is a dry run until you add `--live`. It reads the protected
accounts first, whole and fresh, and sources nobody if it cannot (0031). In
the sandbox, one of the three invented companies is protected: watch it
excluded before anything is spent.

Nobody is reached from there directly. A person constitutes a list from what
a live sourcing run kept (`kernel-list`, at a terminal), drafts are proposed
for it and approved, and `pnpm enrol -- --list <key> --experiment <id>`
enrols the list's people, each carrying the messages approved for them
(0064). It reads protection and the opt-out again, and is a dry run until
`--live`.

Then make it yours, in order, because each step tells you what the next one
needs:

1. **Fill `manifest.yaml`.** Name the instance, enable the domains you want.
   A domain may only be enabled together with everything it depends on.
2. **Replace the sandbox bindings, one at a time.** A published adapter is a
   package name; your own goes in `adapters/`. `adapters/example-crm.ts` is a
   complete one against an invented API — copy it and change the four places
   marked `CHANGE:`. Delete the sandboxes, their data and their state file
   when nothing binds them any more.
3. **Fill `.env`.** Every variable a binding declares must exist; the engine
   says which is missing.
4. **Write your truths.** Start with one, with a real owner and a real date.
   An ICP nobody has confirmed in three months is reported as stale, which is
   the only thing that keeps it honest.
5. **Run `pnpm verify` again.** Every step before this one can be plausible
   and wrong; this is the one that finds out. Not `pnpm doctor`, which is a
   pnpm command of its own and never reaches the engine.

## The two checks

`pnpm check` guards the shape of this repository: no secret, no code outside
`adapters/`, no adapter that reaches into the database or reads the
environment behind the manifest's back. It ships from the engine, so it
improves when you bump the engine.

`pnpm verify` asks whether the configuration is real: it boots, opens a dry
run in the database, probes every adapter that offers a probe, and closes the
run with what happened. It ships from the engine too, as `kernel-verify`, for
the same reason.

At startup the engine validates the manifest — domains, dependencies,
bindings, credentials — and nothing else: startup answers whether the system
can run. Truths are not part of that, because a truth nobody has confirmed
lately must not stop a run from being recorded. `pnpm verify` loads and
reports them, and each process loads the ones it uses where it uses them.

## What never goes here

No domain logic. No schema, no migration, no table. No rule about who is
targeted or suppressed: those are the same for every instance, or they are not
rules, and they belong to a domain.

An adapter that decides who to skip is not an adapter.
