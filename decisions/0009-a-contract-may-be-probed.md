# 0009 — A contract may be probed

## Decided

`Contract`, the base every contract extends, gains one optional method:

```ts
probe?(ctx: CallContext): Promise<CallResult<void>>;
```

It answers two questions and no others: can the provider be reached, and does
it accept these credentials. It is always a read, whatever `ctx.dryRun` says.
Success carries nothing.

`verify` calls it on every adapter that has it. An adapter without one is
reported as "offers no probe" — not as healthy, and not as a failure. A run in
which something was not probed does not end with "this configuration is
real"; it says what was not probed.

## Why

`verify` has to make one call per adapter to tell a real configuration from a
plausible one. It first did that from a table in the instance, keyed by
contract name, choosing a read for each contract it knew — `crm` called
`findCompanyByDomain`. That table could not follow `verify` into the kernel:
it names a business capability and imports a domain's types, and the core
contains no business word and depends on no domain (doctrine 1 and 2).

The generic answer is for the one who knows the provider to say what the
cheapest honest call is. That is the adapter. A contract cannot know it — one
CRM's cheapest authenticated read is another's rate-limited search — and the
engine certainly cannot.

## Why optional

Required, every adapter would write one, and an adapter with no honest probe
would write a dishonest one: `return { ok: true }`, which is worse than
nothing because it reads as health. Optional, absent stays visible as absent.

## Why it carries nothing

What the provider holds is not the question. An answer such as "authenticated
as …" is a detail about an account that a run log should not be handed, and a
probe that returns data invites a caller to start depending on it.

## What this costs

**It touches the base of every contract**, which decision 0005 made a
published surface. It is additive and optional, so no adapter written against
0.1 breaks. That is the only kind of change to `Contract` that is cheap, and
the next one may not be.

**A probe can lie.** Nothing checks that it is cheap, that it is a read, or
that it exercises the credentials. The contract says so; review and the
adapter README are what enforce it.

## Rules out

- A probe table anywhere outside an adapter.
- Treating an adapter that offers no probe as healthy.
- A probe that writes, or that returns what it read.

## Would reverse it

Providers turning out to have nothing cheaper than the calls the contracts
already define — in which case probing is a contract read with an invented
argument, and the method is ceremony. The first three adapters will say.
