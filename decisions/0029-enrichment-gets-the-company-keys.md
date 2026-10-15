# 0029 — Enrichment is asked with the company's keys

Supersedes in part [0024](0024-a-target-carries-its-keys.md), which carried a
target's keys and left the enrolment path finding people by domain.

## Decided

The enrolment path asks enrichment for a company's people with the company's
identity as the target list attests it: its domain, and the other keys
`TargetCompany.identity` carries — an id on a network, when the source holds
one. The identity is normalised against the vocabulary first; one the
vocabulary refuses — a kind or a network nobody declared — is not passed on:
the company is skipped as unreachable, and enrichment is not called.

A candidate without a domain is still unreachable. Protection matches
candidates by domain and by the source's identifier (0019); one it cannot
match by domain is not looked up on the strength of another key alone.

## Why

0024 said the instance that bound a target list filling `identity` and an
enrichment source needing the id would say whether this was needed. It did:
against the first real target list, the enrichment adapter — which finds
people only from an attested company id (0016, 0022) — was handed a domain
for every one of 433 candidates, refused each, and the enrolment path could
not have enrolled anyone. Called directly with the id the target list held,
the same adapter answered.

## Rules out

- Handing enrichment a key the vocabulary refuses.
- Looking up a company the protection pass could not match by domain.

## Would reverse it

An enrichment source for which passing more keys than the domain changes the
answer for the worse — a source that, given two keys, trusts the wrong one.
That would be the adapter's to choose among them, not the path's to withhold.
