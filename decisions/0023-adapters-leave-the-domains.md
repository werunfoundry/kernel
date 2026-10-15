# 0023 — Adapters leave the domains

Supersedes in part [0003](0003-contracts-not-ports.md): where an adapter
lives. Amends doctrine 6.

## Decided

The adapters this repository ships live in `adapters/<provider>/`, at the
root — one folder per provider, whichever domains own the contracts it
satisfies. They form one package, `@werunfoundry/adapters`, and a binding
names one by its folder:

```yaml
- contract: sequencer
  adapter: "@werunfoundry/adapters/<provider>"
- contract: crm
  adapter: "@werunfoundry/adapters/<provider>/crm"   # a provider serving two contracts
```

**An adapter may import the contracts of any domain, and nothing else of the
engine.** `@werunfoundry/<layer>/contracts…` and `@werunfoundry/core/identity`
— the types every contract naming a person or a company is written in (0013).
Not a schema, not the runtime, not a manifest, not another adapter, not a
database client, and no relative import out of its own folder.
`scripts/check.mjs` reads every way a module can be named — `import`,
`export … from`, `import(…)`, `require(…)` — refuses a dynamic import it cannot
read, and holds `template/adapters/` to the same rule. An adapter inside a
domain is refused.

The domains whose contracts the package imports are **peer** dependencies, the
optional ones optional: an adapter speaks the contracts of the domains the
instance enabled, at the version the instance installed, and installing the
package must not bring in a domain the instance did not enable. Every import
of a contract in the shipped adapters is a type, so nothing is loaded from a
domain the instance lacks.

## Why

The rule it replaces placed an adapter in the lowest domain that sees every
contract it satisfies. A provider that is a CRM and an inbound source sat in
`gtm`, because `gtm` depends on `relations` and so sees the `Crm` contract
too. That works while the domains form a line. It fails the first time two
domains sit side by side: a provider serving a contract of each has no
domain that sees both, and the only ways to make one are a dependency between
siblings — forbidden by doctrine 2 — or moving a contract down that does not
belong there. Placement was answering a question about imports with a folder.

The question is about imports, so the check now answers it. An adapter's
boundary is what it may reach, and that is checkable wherever the file sits;
a folder per provider, outside every domain, makes the boundary the same for
all of them.

## What this costs

**Every published binding changes.** `@werunfoundry/<domain>/adapters/<x>`
becomes `@werunfoundry/adapters/<x>`. The packages are not on the registry
yet (0008), so no instance outside this repository holds one; the template
names only the new shape.

**One more package to build, pack and keep in step.** `scripts/try-instance.mjs`
packs it with the others.

**Every provider's code is installed together.** An instance that binds one
adapter installs all of them. Dependency-free adapters make that a few files;
it stops being cheap on the day one needs a provider's SDK.

## Rules out

- An adapter in `domains/<name>/`, or as a loose file at the root of
  `adapters/`.
- An adapter that imports a schema, the runtime, a manifest, another adapter
  or a database client.
- A domain depending on a sibling so that an adapter can see both contracts.

## Would reverse it

The first adapter that needs a dependency of its own that other instances
should not install. That splits the package — one per provider,
`@werunfoundry/adapter-<provider>` as 0005's example already spells it — and
leaves the folders and the import rule as they are.
