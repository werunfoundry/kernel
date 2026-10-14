# 0011 — The sequencer, after a real provider

> Completed by [0012](0012-one-provider-workspace-per-instance.md): one provider workspace per instance.

## Decided

The `Sequencer` contract changes in five places, all forced by writing its
first real adapter — the one in `domains/gtm/adapters/`, written against
a provider's published OpenAPI document and exercised read-only against a
live workspace. The provider is named there and nowhere else (doctrine 6).

1. **`withdraw` splits in two.** `withdraw` takes a person out of *one*
   sequence, and `sequenceKey` is now required. A new `suppress` stops a
   provider reaching a person *or a whole domain* in every running sequence,
   and keeps it stopped. Protection after enrolment (0004) depends on
   `suppress`, not `withdraw`.
2. **`status` names the sequence.** It takes `{ person, sequenceKey }`.
3. **`unsubscribed` is a state** of its own, not folded into `stopped`.
4. **`Enrolment.sender` is optional**, and an adapter that cannot honour an
   explicit sender refuses the enrolment as `invalid`.
5. **Idempotency allows a provider's own sameness.** Replaying a key returns
   its enrolment; a different key landing on an enrolment the provider
   already holds is `conflict`.

`capacity` does not change.

## What the old shape could not express

**Protection is about accounts, and `withdraw` took a person.** 0004 protects
accounts. The old `withdraw(person, sequenceKey?)` could pull out the people
it was told about and nobody else — not the colleague at the same company
enrolled last week by another run. The provider's blocklist takes a domain
and is checked "across ongoing campaigns"; the contract had nowhere to say
that.

**"Remove from every sequence" and "remove from this one" are different
operations.** The provider has no way to stop one lead: a lead's status is
read-only in the API. The two things it can do are delete the lead from a
campaign — synchronous, per campaign, and it erases the provider's record of
that enrolment — or add the address to the workspace blocklist — every campaign,
and every future upload. One method returning `void` cannot be both.

**A person in two sequences has two states.** The provider keeps one lead per
person per campaign. `status(person)` had to pick one.

**An opt-out is not a stop.** The provider reports "unsubscribed" separately from
"skipped" and "completed". Folding it into `stopped` would have hidden the one
state the engine must act on everywhere (`relations.person.opted_out`).

**The sender belongs to the campaign.** The provider rotates across the accounts a
campaign lists; a lead cannot be pinned. A required `sender` would have been
either a lie or a refusal of every enrolment.

**There is no idempotency key.** Nothing in the API takes one. The provider's
sameness is one lead per email per campaign, which `/leads/add` reports as
`duplicated_leads`. The old contract said only that the caller knows what
"the same" means — true, and the provider still decides what it will accept
twice.

## Why `capacity` stays

It is readable and correct as far as it goes: an account's `daily_limit`, and
what it sent today from the daily account analytics. But it is incomplete for
this provider, and the record should say so: a campaign has caps of its own —
a daily sending limit and a daily maximum of *new* leads — that bind before a
sender's does. The contract has no place for them. Changing it needs a second
sequencer, to see whether per-sequence caps are a pattern or this provider's
shape. That is a decision for then.

## What this costs

The contract was a published surface from 0005 on, and this breaks it. Nothing
outside this repository implements it yet, and nothing inside calls it; the
cost today is this file. That is the argument for changing it now.

## Rules out

- Protection implemented as a series of per-person withdrawals.
- An adapter accepting a sender it will not use.
- A status that answers for "the person" across sequences.

## Would reverse it

A second sequencer whose withdrawal and suppression are the same operation,
and a third. Until then the split costs one method and states something true
about the first real provider.
