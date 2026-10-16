# Domains — a projection

> **This is a projection, not a plan, and not an instruction.**
>
> Only two domains exist today: `relations`, and the addressing domain
> (`domains/gtm`). **Everything else in this file is hypothetical.** It
> describes what the split *might* look like if every surface of a company ran
> on the kernel, in order to test the rule of decision
> [0035](../decisions/0035-what-a-domain-is.md) against cases it was not
> written for.
>
> **No agent, and no person acting on an agent's suggestion, may create a
> domain, a table, a schema or a migration from this file.** Nothing here has
> been decided. A domain comes into existence through a decision in
> `decisions/`, written when real work needs it — never because it is listed
> here. If this file and the code disagree, the code is what exists.
>
> This is neither a decision nor doctrine. It is a reference to argue with.

## The core

Three registers, in the projection. The second is not invented: its
machinery — `truthKinds`, `truthsDir`, `loadTruths` — is already in
`core/manifest`.

- **Work** — `experiment`, `run`, `event`, `decision`: what is being tried,
  what ran, what was observed, what was concluded. Plus attribution
  (`actorType`, `actorId`, `runId`) carried by every row (doctrine 5), which
  is not an object.
- **Method** — `truth`, `skill`, `process`: what is held to be true, what is
  known how to do, how it is done.
- **Governance** — `lane`.

That is eight objects: four of work, three of method, one of governance.
A domain declares its `truthKinds` and its `skillKinds` the way it already
declares its `channels` and its `eventTypes`; the instance carries the
content.

**What is real today:**

| Object | State |
|---|---|
| `experiment`, `run`, `event`, `decision` | tables in `core`, the four the core has |
| `truth` | works: files under the instance's `truthsDir`, loaded by `loadTruths`, of kinds a domain declares. One domain uses it. Not a table. |
| `process` | only a string key on a run (`run.process_key`); nothing declares a process |
| `skill` | does not exist |
| `lane` | an enum and a column on `experiment` (`reviewed`, `autonomous`, `reactive`), read by the draft gate (0027); not an object of its own |

## The projected domains

| Domain | Verbs | Objects | Depends on |
|---|---|---|---|
| `relations` | identify, merge, consent, record a contact | person, company, list, list_member, touch, message, signal, consent | — |
| the addressing domain (today `gtm`; name not settled) | select, qualify, draft, send, observe the reply | draft, enrolment, sourcing_result, person_state | relations |
| `publishing` | publish, distribute, rank, measure reach | page, article, keyword, placement, creative, ranking | — |
| `support` | receive, qualify, resolve, escalate | ticket, resolution, sla | relations |
| `product` | collect, arbitrate, ship | request, feedback, release | relations |
| `engineering` | plan, build, deploy, handle an incident | change, deployment, incident | — |
| `finance` | invoice, collect, recognise | invoice, payment, subscription | relations |
| `team` | recruit, onboard, review | role, candidate, member, review | relations + the addressing domain |

**What the two existing domains hold today**, for comparison:

- `relations`: `person`, `company`, `audience`, `audience_member`, `touch`,
  `signal`. No `list`, no `consent` table (the opt-out is a column on
  `person`), and `message` lives in the addressing domain.
- the addressing domain: `message`, `draft`, `person_state`,
  `company_state`, `enrolment`, `enrolment_skip`, `sourcing_result`,
  `protection_acknowledgement`.

## The boundaries, and why

**Identified against anonymous — not inbound against outbound.** The
addressing domain speaks to named people: protection, enrichment and consent
apply to it. `publishing` speaks to anonymous ones: none of that applies, and
the object model has nothing in common.

**An employee is not a `relations.person`.** Legal basis, retention and
access rights differ. `team` keeps its own register; an employee who is also
an external contact exists twice, deliberately.

**`team` reuses the addressing domain** to source its candidates: recruiting
uses the same verbs as prospecting, and only the objects it arrives at
differ.

**The newsletter does not create a domain**: same verbs, same objects as
prospecting. What differs are the guards that fire.

**`audience` is reserved for `publishing`**, in the advertising sense — an
anonymous segment. A set of identified people is called a `list`.

## Ten constraints from the edge cases

Every future implementation must hold to these. Each comes with the case
that motivates it.

1. **The lane's gate belongs to writing the message, not to the draft
   factory.** Otherwise a domain that writes a message without going through
   a draft gets past the human guard.
2. **Consent is per purpose, and carries a legal basis.** An unsubscribe from
   one kind of communication must not block a contractual one. Purposes are
   declared per domain.
3. **A person's affiliation to a company is bounded in time**, and being a
   customer is a property of that relationship, not of the person alone.
   Otherwise a former contact at a customer can never be approached again —
   or the memory of what they were is lost.
4. **The solicitation cap is read from touches, not from a domain's state**,
   and a touch says whether it was solicited. Only unsolicited touches count
   against the cap; a reply is never blocked by a cadence.
5. **Erasure is declared per domain** — delete, anonymise, or keep with a
   legal basis — and the core orchestrates. It is not a cascade: an
   accounting obligation outlives a right to erasure.
6. **The "customer" fact is written by the domain that observes the
   payment**, not by the one that prospects.
7. **Account expansion is impossible today**: protection excludes a whole
   company domain, so a prospectable entity inside a customer's group cannot
   be reached. A deliberate, cautious choice; the way out would be an intent
   opened explicitly by an operator, and recorded.
8. **An instance knows one brand.** Several brands require several
   instances, and so several registers of people.
9. **A list is a selection, never a permission.** Consent and protection are
   evaluated at sending time.
10. **An experiment may cross domains; metrics are declared in each.**
    Nothing prevents it, nothing organises it.

## What is not a domain

Teams — sales, marketing, growth, revenue operations — belong to the org
chart. Channels — email, social, ads, phone — are a field. The newsletter,
recruiting and the product announcement use the same verbs as prospecting.
Strategy is already covered by `experiment` and `decision`. Analytics has no
verbs of its own.

## Seams noticed, not settled

In `publishing`, owning a surface and renting one share the verb but not the
objects — probably two domains one day. Between `product` and `engineering`,
the boundary will blur at the first incident caused by a release.

## On naming

The addressing domain's name is not settled. Its scope covers prospecting,
recruiting, the newsletter and the product announcement, and it changed
three times in two days as tests went on. A domain whose boundary is still
moving is not renamed.
