# 0024 — A target carries its keys

> Superseded in part by [0029](0029-enrichment-gets-the-company-keys.md): the
> enrolment path reads `identity` and hands it to enrichment.

Completes [0013](0013-an-identity-is-a-set-of-keys.md), which made an identity
a set of keys, and [0004](0004-protection-is-its-own-route.md), whose
`TargetList` predates it.

## Decided

`TargetCompany` gains an optional `identity`: the company's keys as the
source holds them, subject `company`. A `domain` key repeating `domain`, and a
networked company id when the source has one, on a network the instance
declares.

Two obligations come with it, on the adapter:

- **`domain` is repeated among the keys**, so that the field and the identity
  never say two things.
- **Only keys the source carries.** A company id looked up from a domain is a
  guess, which 0016 refuses from an enrichment source and this refuses from a
  target list.

It is optional. A source that knows only a domain says so through `domain`,
and the adapters that exist keep working unchanged.

`ProtectedAccount` is not changed. Protection matches on domain and on the
source's identifier (0019), and nothing yet asks it to match on a networked id.

## Why

The first warehouse-backed target list holds, for most companies, both a
domain and the company's id on a social network — and every row with the id
also has the domain. The contract had nowhere to put the id except
`externalId`, which is the source's own identifier and is matched against the
protected set's (0019): putting a network's id there would compare two
identifier spaces as if they were one. Or `attributes`, which the engine never
interprets by definition, so a key put there is a key thrown away.

The enrichment adapter already waits for exactly this: it finds a company's
people only from an attested company id, never from a domain (0016, 0022), and
says it cannot serve the enrolment path "until a target list carries a
company's social key".

## What this does not do

**The enrolment path does not read it yet.** It still finds people by
`domain`. Changing that is engine capacity, and the rule is that none is added
before a real instance has run and said what it lacks. The first instance that
binds a target list filling `identity` and an enrichment adapter needing the
id will say it.

## Rules out

- A networked key in `externalId`.
- A key the source does not hold, derived from one it does.

## Would reverse it

A target list whose companies need more than keys to be told apart, which is
0013's reversal condition, one level up.
