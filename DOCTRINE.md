# Doctrine

This repository is public. Everything in it is written to be read by people who
do not work here, and nothing in it describes any particular company.

These rules are not style. Each one exists because its absence has already cost
something, somewhere. Where a rule can be checked by a machine, it is — see
`scripts/check.mjs`. The rest are enforced in review.

## 1. The core decides, domains describe

The core holds governance: what is being tried, what was decided, what ran. A
domain holds a line of business: its entity types, its event types, its
experiment types, its capabilities.

- **The core contains no business word.** No lead, no campaign, no feature.
- **A domain never adds a core object.** It adds its own types.
- **If the core grows past ten objects, the overflow moves into a domain.**

## 2. Dependencies point down, never sideways

`core` is the bottom. Domains sit above it. A domain may depend on another
domain only by declaring it in its `domain.yaml`.

- A foreign key may point into `core`, or into a declared dependency. Never
  sideways, never upward.
- A sideways read goes through a view the owning domain publishes, never
  through a foreign key into its tables.
- **When two domains need the same concept, it moves down — not sideways.**
  Two domains needing the same thing is the signal that it belongs to the layer
  beneath them.
- A domain never writes into another domain's entities. To extend an entity of
  a domain it depends on, it adds a table of its own in its own schema.

Schemas make this physical: `core`, then one per domain. Uninstalling a domain
is dropping its schema.

## 3. The database is not a system of record, and not a warehouse

- A fact this system does not own is **read, never copied**. It keeps a
  reference and the fields it computes itself.
- Metrics are read from their source when someone needs them. The only numbers
  kept are those a decision rested on, frozen at the moment it was taken.
- Bulk history belongs in a warehouse, which is just another connector.

## 4. Correctness lives in the schema

- **Every write path that can replay carries its uniqueness key in the DDL**,
  not in the caller. Correctness must not depend on the caller being careful.
- **Delete policy is chosen by meaning**: cascade is ownership, set null is
  attribution, restrict guards what was already sent.
- **Every index names the query it serves**, in a comment above it. An index
  with no named query is a guess.
- **Always qualify table names.** Never rely on `search_path`: a transaction
  pooler does not carry it reliably, and the failure is intermittent.
- Extensions live in `public`, never in a domain schema. A domain that is
  dropped must not take an extension with it.

## 5. Attribution without authentication

There are no users, no sessions, no roles. Nothing here consumes a browser
session.

Every row that records an action carries `actorType`, `actorId` and `runId`.
"Which run produced this" is answerable. "Who is logged in" is not a question
this system asks.

## 6. Operating rules

- Dry run before the real run, in the same session.
- Upsert only, with an idempotency key.
- Suppression fails closed — on **freshness** as well as reachability. A source
  that answers cheerfully with last week's rows is worse than one that is down,
  because it looks like protection.
- The audit gate exits non-zero and blocks activation.
- **Every machine-read file is parsed by the checks.** A manifest only a human
  has read is not known to be valid. A file that the build parses and the
  checks do not is a gap that is discovered in CI at best.
- Never invent a schema field. Query the live schema first.
- A **contract** is what the engine requires of the outside world: a CRM, a
  sequencer, a list of targets. An **adapter** is one way of satisfying it.
  (This is the ports-and-adapters pattern. We call them contracts because
  that is what they are, and because a reader should not need the pattern's
  name to understand the folder.)
- A provider is named only inside its adapter — which may live in exactly one
  place, `domains/<name>/adapters/`. Never in a domain, never in the core.

## 7. This repository is public

- **No instance, brand, client or customer name appears anywhere** — not in
  code, comments, commit messages, tests, fixtures, or documentation.
- **Fixtures are invented.** Addresses and domains use `example.com`,
  `example.org` or `.invalid`. No real profile URLs, no real company names.
- **No secret, ever, not even briefly.** History is permanent and is crawled
  within minutes. A secret removed in the next commit is already gone.
- Configuration and secrets live in the instance, never here.

## 8. What belongs to the instance

An instance is generated from `template/` and depends on this package. It is
not a copy of this repository.

It holds its configuration, its context, its manifest values and its secrets.

It may also hold adapters, in one place — `adapters/` at its root — because
there is always a tool this repository did not anticipate, and an engine that
can only be used with the adapters it ships is not agnostic. A binding names a
relative path for an instance's own adapter, or a package name for a published
one.

It holds nothing else that is code. No domain logic, no schema, no migration,
no rule about who is targeted or suppressed. An adapter that reaches into the
database, or that decides who to skip, is not an adapter — it is a domain
that was written in the wrong repository.

Both halves of that boundary are checked, by a check this package ships and
the instance runs.
