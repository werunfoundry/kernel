# 0001 — A public, generic engine, with private instances

> Superseded in part by [0005](0005-an-instance-may-carry-its-own-adapters.md):
> an instance may carry its own adapters.

## Decided

The engine is one public repository, owned by an organisation that is not any
of the companies using it. Each company that runs it has its own private
repository, generated from `template/`, holding its configuration, its context,
its manifest values and its secrets — and no engine code.

Instances depend on the engine as a pinned package. They are not forks.

## Why

The first version of this system was written inside one company, for one
company, and absorbed that company's assumptions until the second use case
required rewriting rather than configuring. The assumptions were never decided;
they accumulated, because nothing made them visible.

A public repository cannot quietly accumulate them. Writing a client's name is
not a style violation there, it is a disclosure, which means the generic
boundary is enforced by something other than discipline.

The second reason is cheaper to state: three companies sharing a fork is three
divergent codebases within a year. Three companies sharing a dependency is one.

## Rules out

- Instance-specific branches or flags in the engine.
- A tenant column. One deployment is one tenant; separate data is separate
  databases, not a discriminator that someone will forget in a `WHERE`.
- Accepting the engine's configuration as "just a file in the repo".

## Would reverse it

A capability that genuinely cannot be expressed as configuration, needed by one
instance, where the alternative is worse than a fork. None has appeared yet;
the manifest has absorbed every candidate so far.
