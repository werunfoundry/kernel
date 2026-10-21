# 0004 — Accounts that must not be contacted are their own route

> Completed by [0019](0019-the-enrolment-path.md): the enrolment path checks it, fail-closed, and the kernel decides when it is stale.

> Completed by [0012](0012-one-provider-workspace-per-instance.md): a provider blocklist is defence in depth, not protection.

> Completed by [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
> protection that becomes true mid-sequence suspends every enrolment the
> registry holds at the account, beside `suppress`.

> Superseded in part by [0057](0057-a-newly-protected-account-is-stopped-when-a-run-looks.md):
> a newly protected account is stopped when an enrolment run or its own
> command looks, and only as often.

## Decided

A target list exposes two independent reads: candidates, and protected
accounts. They are separate because the protected set is **not** a subset of the
candidate set.

A contract that provides them must also answer `freshness(route)`. Suppression
fails closed on freshness as well as on reachability: a caller that cannot
establish how old the protected set is refuses to enrol.

Protection is re-checked at enrolment, not only at sourcing, and a newly
protected account is withdrawn from sequences already running.

## Why

Two deployments of this engine may work the same market from different angles.
One contacting the other's customer is not a duplicate touch; it is the kind of
mistake that is explained to a customer rather than to a colleague.

Modelling protection as a flag on a candidate row is the obvious design and it
fails exactly where it matters. An account becomes protected without ever having
been a candidate — it arrived through an inbound channel, in the other
deployment. A flag on rows that were never fetched protects nothing: the account
is absent from the list, therefore excluded nowhere.

The freshness requirement comes from the same shape of failure. A source that
answers promptly with last week's rows looks exactly like protection and is not.
An unreachable source is noticed; a stale one is trusted.

## Rules out

- A denylist file in any repository. It would be a list of customer names in
  version control, which rules 7 and 8 forbid, and it would be stale the day
  after it is written.
- Protection evaluated only at sourcing time.
- A source that cannot say how old its answer is.

## Would reverse it

A single system of record that both deployments write to, where a customer is
one row and protection is one join. That would be a different architecture, not
a change to this one.
