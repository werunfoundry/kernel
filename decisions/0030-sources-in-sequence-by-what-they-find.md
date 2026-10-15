# 0030 — Sources in sequence, by what they find

> Completed by [0031](0031-the-sourcing-path-and-the-crm-as-exclusion.md): the sourcing path replays the person check on the completed identity, as this decision required.

Supersedes in part [0016](0016-enrichment-says-whether-it-looked.md), which
put finding a company's people and completing an identity in one contract.
Completes [0015](0015-one-adapter-per-contract-and-channel.md), which bound a
contract more than once only per channel.

## Decided

**Two contracts where there was one.** `people_source` finds the people at a
company (`peopleAt`). `enrichment` completes an identity (`complete`). They
are two capabilities, and the providers that offer them differ: one finds
people and rarely an address, another finds addresses and no people. One
module may satisfy both; it is bound once under each name.

`people_source` is bound once. Two sources of people would be two lists of
whom to contact, which 0016 refused as a second target list.

**An adapter declares what it can find.** `finds`, an optional member of
every `Contract` beside `channels`, names the identity key kinds its answer
can attest — `email`, `phone`. Every kind must be one an enabled domain
declares. A binding may name `finds` to take some of them; by default it
takes all the adapter declares.

**A contract bound more than once is bound per channel (0015) or in
sequence — never both.** In sequence, every binding takes at least one kind,
and none takes a channel. The order is the order of `providers` in the
manifest, and `kernel-verify` prints it per kind, so a reordering shows as a
change in who is asked first. The registry answers `sequence(contract)`;
`get` and `require` still refuse to pick one.

**A sequence advances on absence, never on failure.** `completeInSequence`,
in `relations`, asks each source in order only for the kinds still missing,
and only for kinds it finds:

- *Not found*, or found without a wanted kind, or an answer
  `acceptCompletion` rejects: the kind is still missing, the next source is
  asked for it, and the step is recorded with its reason.
- *Could not look* — any error: the walk stops for that subject, and the
  error is returned with the source that raised it. The next source is not
  asked.

## Why stop on an error

A source that failed has not said the key is absent. Asking the next one
pays a second provider for an answer the first may have held, and hides the
failure behind a result that looks complete. 0015 refused a fallback because
a failure in one sequencer would silently send through another; this is the
same refusal for reads that cost money. The difference from a fallback is
the trigger: the next source runs because the previous one *looked and did
not find*, which it said in so many words (0016).

## What completing changes for protection

Protection matches a person by the addresses they have (0019). Found by a
`people_source`, a person usually has none, so the check runs and cannot
conclude. Today nothing adds an address afterwards, and the identity checked
is the one the sequencer receives. Once completion enters the path, that
stops being true.

**A check that runs without being able to conclude is worse than a check
that is absent**: an absent check is seen to be missing, a vacuous one reads
as passed. So when the enrolment path completes an identity, the person check
runs on the completed identity — the one the sequencer will receive — and a
person whose completion stopped on an error is skipped, never checked on what
they were before it.

## Rules out

- Finding people and completing them through one binding that does both.
- Two sources of people for one instance.
- A contract bound partly per channel and partly in sequence.
- Asking the next source after an error.
- Asking a source for a kind it did not declare.

## Would reverse it

A source whose answer is cheaper or better asked after the paid one — which
is an order, and stays a manifest change. A source that cannot say "not
found" apart from "could not look" would break the sequence at its root; it
is not an enrichment source (0016).
