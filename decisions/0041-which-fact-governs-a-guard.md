# 0041 — Which fact governs a guard

Completes [0036](0036-a-state-is-declared-and-kept.md) and
[0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md).
Each left a fact with two possible readings and a guard that reads one of
them. These are the two choices, and what they cost.

## Decided

### 1. Protection reads the source, never the declaration

**"This is a customer" has two answers now.** One is declared by a person
in `relations.relationship` (0036). The other is the protected set, read
live from the source the instance binds to it — where an instance has one,
a fact derived from billing and kept in a warehouse (0031–0034). **Protection
reads the second, and only the second.** It fails closed on that source's
freshness (doctrine 6); a declaration has no freshness to fail on, and a
person's word that someone is a customer is not the record of their paying.

What follows, on purpose:

- **Declaring someone a customer protects them from nothing.** The
  declaration is for the people and domains that read relationships; the
  protected set is what stops a run.
- **A person who changes company keeps their declaration** — `customer`,
  or a stage of the motion — until a person declares another. Nothing
  prompts that correction. A person's company is recorded once and never
  overwritten (`recordPerson` fills what is empty), so the record does not
  see the move either. The natural trigger would be a job-change signal
  (`relations.signal`): it is not built, and until it is, the correction
  depends on someone noticing.
- Protection itself is not misled by the move: it judges a candidate by the
  company the target list gives for it now, and by any address it carries —
  never by the company `relations` recorded.

### 2. The opt-out stays global, and closes rather than serves

`writeMessage` (0038) refuses every message to a person who opted out —
solicited, transactional or contractual, as well as unsolicited. **That is
chosen**, not overlooked: one global opt-out is the only consent the record
holds, and a guard that guessed which messages an opt-out was meant to
cover would be guessing about the one thing a person asked of us. It closes
until consent is split by purpose.

What follows: **the day a domain invoices, a customer who opted out will not
receive their invoice** through this gate. That domain cannot be built on
this gate as it stands; per-purpose consent comes first.

This is the second tension in
[`docs/domains.md`](../docs/domains.md#tensions-with-existing-doctrine) —
consent per purpose against the global opt-out. This decision does not
close it; it says what holding it open costs, and keeps the existing opt-out
as the purpose that will be named "all".

## Rules out

- Protection read from, or relaxed by, a declared relationship.
- A declaration corrected by inference from a person's recorded company.
- A message sent past an opt-out because it was solicited or contractual,
  before consent has purposes.

## Would reverse it

For 1: a declared relationship that has its own source and freshness — a
domain that observes the payment and writes `customer` itself (0036, *Not
done here*). Then the declaration and the protected set may become one fact.
For 2: consent split by purpose (constraint 2), which narrows what an
opt-out refuses.
