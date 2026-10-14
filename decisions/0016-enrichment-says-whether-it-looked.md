# 0016 — Enrichment says whether it looked

## Decided

`relations` gains an `Enrichment` contract with two reads:

- **`peopleAt({ company })`** — the people at one company, a page at a time.
- **`complete({ identity, want? })`** — more keys for one subject.

**Not found and could not look are different answers.** A search that ran and
matched nobody is a success: an empty page, or `{ found: false }`. A search
that did not run — provider down, key refused, credit exhausted, input not
understood — is an error. An adapter never maps the second to the first.

**A completion is checked before it is trusted.** `acceptCompletion` rejects
an answer that conflicts with the identity asked about — an immutable key of
the same kind with another value, which by 0013 is someone else — or that
changes the subject, or drops a key it was given. It returns the keys the
provider added, and nothing is merged otherwise.

## What it deliberately does not do

The sequencer has no `send`, and the CRM has no bulk import. This contract
has four such gaps, each on purpose:

- **No search without a subject.** No "everyone matching these criteria".
  Choosing whom to look at is the target list's job (0004); a criteria search
  here would be a second target list, outside the protection that the first
  one carries.
- **No invented keys.** An address assembled from a name and a domain is a
  guess. Only keys the provider attests are returned, and a provider that only
  guesses is not an enrichment source.
- **No verdict on a key.** Whether an address delivers belongs elsewhere, if
  anywhere.
- **No persistence.** It returns keys and display fields. What is kept is the
  domain's decision, and attributes the engine does not own are read, not
  copied (doctrine 3).

## Why here

People and companies are `relations`' objects, and both `gtm` (to find whom
to enrol) and any later domain (to complete a record) need it. When two domains
need it, it belongs in the layer they share. That is `relations`, not the core,
which has no word for a person (doctrine 1).

## Rules out

- An empty result standing for a failed search.
- A completion merged without being checked against what was asked.
- Searching by criteria rather than by subject.

## Would reverse it

A provider whose only interface is a criteria search. It would be a target
list, and would be bound as one.
