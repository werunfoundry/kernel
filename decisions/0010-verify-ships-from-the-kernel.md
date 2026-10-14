# 0010 — verify ships from the kernel

## Decided

The check that makes an instance's configuration real rather than plausible
is `kernel-verify`, a command the core package ships beside
`kernel-check-instance`. An instance runs it as `pnpm verify`. The logic is
`core/runtime/verify.ts`; the command only finds the instance — the working
directory — and loads its `.env`.

It connects to the database with the instance's own `pg` and `drizzle-orm`,
resolved from the instance root as decision 0007 resolves every name an
instance chose. The core declares neither.

The template no longer holds a `scripts/` folder. An instance's code is its
adapters.

## Why

Decision 0005's argument for shipping the instance check from the kernel holds
word for word: a lesson learned in one instance should reach the others
through a version bump, not through a copy nobody repeats. `verify` already
had one such lesson — `pnpm doctor` is pnpm's own command and silently runs
instead — and a copy in each instance would have kept it only where it was
learned.

Moving it was blocked by its probe table, which named a contract and imported
a domain's types. Decision 0009 removed the table; this is what it was for.

## The driver

`run.ts` says the engine does not pick a driver, because a library that does
decides its consumer's connection pooling. A command is not a library, and
one connection for one run decides nothing about pooling — but it still
should not install a driver the instance did not choose, or carry a second
copy of the one it did. So it uses the instance's. An instance without `pg`
and `drizzle-orm` is told to add them; the template already depends on both.

It is node-postgres, through drizzle. An instance that chose another driver
can still run everything else, and `verify` tells it what it is missing.

## Rules out

- A `verify`, or any other script, copied into each instance.
- The core depending on a database driver.

## Would reverse it

An instance that cannot install `pg` — a runtime with no TCP sockets, say —
would need `verify` to accept its own connection. That is an option on
`verify()`, not a copy of it.
