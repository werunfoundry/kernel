# 0040 — An HTTP API, and erasure declared by each domain

> Superseded in part by [0049](0049-erasure-reaches-a-person-by-keys-and-says-what-it-does-not.md):
> erasure reaches a person by their keys too, and a run's history is
> anonymised, not deleted as acquisition first declared it.

> Superseded in part by [0053](0053-an-enrolment-is-history-once-its-person-is-erased.md):
> acquisition's enrolment row is anonymised, no longer deleted.

> Completed by [0056](0056-erasure-stops-the-person-before-it-forgets-them.md):
> a domain may declare a step the core runs before erasure, outside its
> transaction, failing closed.

## Decided

**An HTTP API, described by OpenAPI.** `api/openapi.json` is the contract;
`kernel-api` serves it, from a new package, `@werunfoundry/api`, which
depends on the core and the domains and is not a domain. It is built on
Node's own `http` module: no dependency is added. Every route in the server
is in the document and every route in the document is in the server, and a
test holds both. **No MCP server here**: it comes later as a thin adapter over
this contract, so that it inherits the API's access rules rather than
imposing its own.

**What the API is not.** It accepts no event: 0017's ruling out of a webhook
endpoint stands, and inbound is still pulled. It is the first thing that
exposes the kernel to a network, which is why the two parts below come in
with it, not after.

### Authentication, and the question of rights

**One token per instance.** A request carries it as a bearer token,
compared in constant time; `kernel-api` will not start without one, or with
one shorter than 32 characters. The token says that the caller is someone
the instance gave it to. **It says nothing about who.**

**What the API assumes of an actor.** `actorType` and `actorId` remain
attribution, declared by the caller (doctrine 5). Over a network, with one
token, any caller can declare any actor — so the API refuses
`actorType: human` outright. Every act the schema reserves for a person —
approving or dropping a draft, acknowledging a customer, declaring a state,
recording a decision, erasing someone — is not on the API. An agent behind
the token can do over HTTP what an agent may do, and nothing a person must.

**The question, asked and not answered.** "May this actor run this process
in this domain" needs two things the kernel does not have:

1. **An actor identity that is verified, not declared** — for instance a
   token per actor, issued by the instance, so the token *is* the identity.
2. **Rights stated against processes** — which domain's process, for which
   actor or kind of actor. A process is today a string on a run, not
   something declared (see below), so there is nothing yet to grant.

Neither is chosen here. The first case that needs a person to act through
the API decides them, in a decision of its own.

### Erasure and retention

**Each domain declares, for each of its tables that names a person, what
erasure does to it**, in its `domain.yaml`: `delete` the rows, `anonymise`
listed columns, or `keep` them under a stated legal basis. It is not a
cascade: an accounting obligation outlives a right to erasure, and only the
domain knows which of its rows carry one. A table that names a person and is
not declared fails a test — not an erasure.

**The core orchestrates.** One person, one transaction, one run: the domains
answer from the top of the dependency order down to `relations`, then the
person's row is deleted — or, when a kept row still names it, emptied of
everything that identifies them and kept as the shell those rows point to.

**Erasing is a person's act**, at a terminal (`kernel-erase`), as an
acknowledgement is (0034). The API shows the plan — what each domain would
do — and does not carry it out, for the reason above.

## Tensions left open

- **Doctrine 5** says there are no users, no sessions, no roles, and that
  "who is logged in" is not a question this system asks. One token per
  instance is none of those, so it holds today. The day rights per actor
  exist, it no longer does, and must be rewritten then — not quietly now.
- **0017** argues that the kernel "runs as commands, with no server". It
  rules out a webhook endpoint, which this does not add, but its premise is
  no longer true of every deployment. Both texts stand.

## Not done here

- **Routes for 0036–0039.** States, lists, messages, events and decisions
  are in the schema, and not yet served: each is added to the document and
  the server in its own change. Those only a person may write stay off.
- **Rows that name a person by keys, not by id** — a skip, an excluded
  sourcing result, an event's payload — are not reached by an erasure by id. Matching on keys is
  not built; until it is, those rows are what an erasure leaves.
- **No domain keeps anything yet.** The two domains delete; `keep` exists for
  the domain that will carry an obligation, such as one that invoices.
- **A skill, and a process as data.** The kernel has no `skill` object — the
  word appears nowhere — and `process` exists only as a string key on a
  run. These are the two pieces a domain would need to bring a way of working
  without shipping code. To be decided on their own.

## Rules out

- An MCP server written before the API it would sit on.
- A request without the instance's token; an API started without one.
- A person's act carried out through a token that cannot say who acts.
- Erasure as a cascade; a table naming a person with no declared answer.

## Would reverse it

A verified actor identity, decided as above — then person-only acts can come
to the API, behind it. Or a deployment that never exposes the kernel to a
network, for which the commands remain enough.
