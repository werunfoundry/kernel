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
  instead.

## Starting one

```
node scripts/new-instance.mjs ../my-instance
cd ../my-instance && git init && pnpm install
```

Then, in order, because each step tells you what the next one needs:

1. **Fill `manifest.yaml`.** Name the instance, enable the domains you want,
   and delete the example binding. A domain may only be enabled together with
   everything it depends on; the engine refuses the rest at startup rather
   than letting a foreign key point at a schema nobody installed.
2. **Write the adapters your bindings name.** `adapters/example-crm.ts` is a
   complete one against an invented API — copy it and change the four places
   marked `CHANGE:`. Delete it once you have your own.
3. **Copy `.env.example` to `.env` and fill it.** Every variable a binding
   declares must exist; the engine says which is missing.
4. **Run the migrations**, in dependency order — core, then each domain. The
   engine's `db:migrate` does the ordering.
5. **Write your truths.** Start with one, with a real owner and a real date.
   An ICP nobody has confirmed in three months is reported as stale, which is
   the only thing that keeps it honest.
6. **Run `pnpm verify`.** It boots the instance, opens a dry run in its
   database, makes one read through each adapter it knows how to probe, and
   closes the run with what happened. Every step before this one can be
   plausible and wrong; this is the one that finds out. Not `pnpm doctor`,
   which is a pnpm command of its own and never reaches this script.

## The two checks

`pnpm check` guards the shape of this repository: no secret, no code outside
`adapters/`, no adapter that reaches into the database or reads the
environment behind the manifest's back. It ships from the engine, so it
improves when you bump the engine.

`pnpm verify` asks whether the configuration is real: it boots, opens a dry
run in the database, probes every adapter that offers a probe, and closes the
run with what happened. It ships from the engine too, as `kernel-verify`, for
the same reason.

The engine validates the manifest itself at startup — domains, dependencies,
contracts, truths — where it is parsed anyway.

## What never goes here

No domain logic. No schema, no migration, no table. No rule about who is
targeted or suppressed: those are the same for every instance, or they are not
rules, and they belong to a domain.

An adapter that decides who to skip is not an adapter.
