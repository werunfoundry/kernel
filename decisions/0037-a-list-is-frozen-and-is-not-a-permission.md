# 0037 — A list is frozen, and is not a permission

## Decided

**`relations.audience` becomes `relations.list`**, and `audience_member`
becomes `list_member`. A list is a set of identified people or companies.
"Audience" is the advertising word for an anonymous segment, which an
instance will one day handle in a domain of its own; it is kept free for
that. Nothing wrote the table, so the rename costs no data — and the
migration refuses to run, rather than drop rows, on a database where
something did.

**A list is frozen at the moment it is constituted, with its query kept
beside it.** Members are written in the same transaction as the list, which
is then sealed: after that, the schema refuses any new member and any change
to one, and any change to the list but its sealing. The query that produced
it — whatever the selecting process declares, kept as it was given — stays
on the list, so the selection can be replayed into a new list and the two
compared. The one deletion let through is a member's, so that erasing a
person is never blocked by a list they were once on.

**A list is constituted by a run**, attributed like every other row: any
actor may select, and the run that did is restricted from deletion, because
it is the evidence of what was targeted. Constituting a list whose key
already exists changes nothing, and says so.

**A list is a selection, never a permission.** Consent, opt-out and
protection are evaluated when something is sent, never when a list is made.
A list frozen in January holds someone who opts out in February; the
enrolment reads the opt-out then (0032), and protection reads its source
then (0031–0034). No code may treat membership as leave to contact.

## Why frozen

A list is the evidence of what was targeted. A query re-evaluated on each
read answers "who matches now", and an experiment debriefed in March needs
"who was selected in January" — which a saved query cannot give back once
the data under it has moved. Keeping the query beside the frozen members
gives both: the evidence, and the means to select again.

## What leaves with `audience`

`audience` also carried **exclusion**: `kind = exclude`, a freshness window,
and the rule that membership is re-evaluated and never trusted once written.
That is suppression, and suppression must not be frozen — it is exactly
what has to be read at send time. It already is: protection reads its
source live and fails closed on freshness (0031–0034), and the opt-out is on
the person. So `kind`, `refreshed_at` and `max_staleness_minutes` go, and
an exclusion set, if one is ever needed beside those, is not a list.

## Closes

The third tension in `docs/domains.md`: `audience` is free for `publishing`.

## Not changed

- The experiment type **`audience_test`** keeps its name. It is stored in
  live `core.experiment` rows and declared by instances; renaming it is a
  data migration with a reason of its own.

## Rules out

- A list re-evaluated on read.
- A member added to, or changed in, a sealed list.
- Membership standing for consent or for an exemption from protection.
- An exclusion set stored as a list.

## Would reverse it

A selection that must follow the data — a list meant to stay current, such
as "everyone at this stage". That is a saved query, not a list, and would
be a different object beside this one, not a change to it.
