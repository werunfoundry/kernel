# 0003 — They are called contracts

## Decided

What the engine requires of the outside world lives in `contracts/`. One way of
satisfying a contract is an adapter, in `domains/<name>/adapters/`, which is the
only place a provider may be named.

The base types are `Contract`, `CallContext`, `CallResult`, `CallError`. In a
manifest, a provider binding names the `contract` it satisfies.

## Why

This is the ports-and-adapters pattern and "port" is its standard word, which is
its only advantage. A port, outside the pattern, is a hole in a wall; a contract
is an obligation, which is what this actually is. The repository is public and
is read by people who run go-to-market teams, not only by backend engineers, and
a vocabulary that requires having read Cockburn is a permanent tax on every one
of them.

`DOCTRINE.md` names the pattern once, so that someone who knows it can map the
two.

## Rules out

- `integrations/`, which makes a reader expect implementations and find
  interfaces.
- `interfaces/`, which in TypeScript means everything and therefore nothing.

## Would reverse it

Nothing foreseeable. It was renamed before the first commit precisely because
after it, renaming costs every instance repository.
