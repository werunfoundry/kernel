# 0033 — Protection matches the company id too, and is not an identity

Completes [0019](0019-the-enrolment-path.md), which matched a candidate to a
protected account by domain and by the target list's own identifier, and
[0024](0024-a-target-carries-its-keys.md), which gave a candidate its keys.

## Decided

**A protected account carries its keys, as a candidate does**: its domain,
and its company id on a network, when the source holds one. A company is
protected if any of them is a protected account's — its domain, its company
id on the same network, or the target list's own identifier. Either key is
enough, and both routes are always read: an account the source knows only
by its id is protected, and so is one it knows only by its domain.

**The protected set is not an identity source.** It is read to protect and
for nothing else. Nothing from it is written to `relations`; no key is
created or reconciled from it; no difference between two of its rows, or
between two reads of it, is a conflict. A source may name one company id for
a domain in one build and another in the next — several companies sharing a
domain upstream, an aggregation picking one — and the run goes on: the
account is protected under whichever ids it carries when it is read.

**Accounts are counted, not rows.** Rows that share a key — a domain, a
company id, an identifier — are one account. The run records the distinct
count beside the number of rows read.

Unchanged: freshness fails closed on the age the source gives (doctrine 6),
and an account with no key at all — no domain, no company id, no identifier
— stops the run, because nothing could be matched against it.

## Why not reconcile the ids

Treating a changed id as a contradiction would stop a run because the
source rebuilt itself, not because anything was unsafe. Treating the set as
an identity source would let a table built for exclusion decide who a
company is in `relations`, from ids it does not even hold stably. Protection
only needs "is this candidate one of them?", and any key answering yes is
enough.

## Rules out

- Writing to `relations` from the protected set, or comparing its rows as
  identities.
- Failing a run because a domain's company id changed between builds.
- Matching a company id across networks.
- Reporting rows as accounts.

## Would reverse it

A protected set whose ids are stable and authoritative, maintained as the
record of who the customers are. It would then be an identity source, and
reading it as one would be its own decision.
