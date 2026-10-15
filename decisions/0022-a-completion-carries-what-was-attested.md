# 0022 — A completion carries what was attested, not what was asked

Supersedes in part [0016](0016-enrichment-says-whether-it-looked.md): what
`complete` returns, and when `acceptCompletion` accepts it.

## Decided

A completion that found its subject returns **only what the provider's
answer carries**:

```ts
{ found: true, attested: Identity, asOf }
```

`attested` holds the subject and the keys the answer names. A key the request
carried and the answer did not repeat is not in it. `added` is gone: the keys
an answer adds are computed by `acceptCompletion`, not claimed by the adapter.

**An answer is accepted only when it attests an immutable key of the subject
asked about, and none that differs** — 0013's `same_immutable`. Otherwise it
is rejected:

- an immutable key differs: someone else, as before;
- only mutable keys in common: evidence, and 0013 merges nothing on evidence;
- no key in common: the provider's word alone.

It follows that **an identity with no immutable key cannot be completed.**
Nothing a provider says could tie its answer to it.

## Why the contract, and not the adapter

0016 required an adapter to "return every key it was given", and rejected an
answer that dropped one. Both meant to catch an answer about someone else.
Together they made it undetectable: an adapter that obeys copies the profile
id from the request into the answer, so the answer always holds the id asked
about, whether or not the provider named it. The one check that compared the
two could not fire.

The hole was found on the enrichment adapter, whose lookup is built from a
profile handle. A handle is mutable and reassignable. A fake provider that
answered another person's address and no profile id was accepted twice: with
the original person's id in the request, and with the handle alone. Both
attached a stranger's address to the original identity.

The adapter could have refused an answer without an id. Every later adapter
would then have had to know to do the same, and the first that did not would
reopen the hole silently, with a contract that told it to. The difference
between "the provider said so" and "we told the provider" is the only
evidence a completion has, so it is part of the shape, and the check that
uses it sits in `acceptCompletion`, which every caller goes through.

## What it costs

- **An adapter whose provider never names an immutable key completes
  nothing.** That is the intended outcome: its answers were never tied to
  the subject. The template's sandbox answered with an address only, and
  would have been rejected every time — an example that taught nothing. It
  now gives each invented person an invented profile id, on a network the
  template's manifest declares, so it shows the shape that is accepted.
- **The enrichment adapter is only as useful as its provider's answer.** If
  the contact lookup does not return the profile id, every completion it
  makes is rejected. This was not verified against a real workspace.

## Rules out

- An adapter copying a key from the request into its answer.
- A completion accepted on mutable keys, or on none.
- An adapter declaring which keys it added.

## Would reverse it

A subject for which no immutable key exists anywhere, yet whose completion is
needed. Accepting on evidence would then need its own decision, saying what
evidence is enough and what is done when it turns out wrong.
