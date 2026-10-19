# 0036 — A state is declared by a person, and kept

> Completed by [0041](0041-which-fact-governs-a-guard.md): protection reads
> the source, never the declaration.
>
> Completed by [0046](0046-the-addressing-domain-is-acquisition.md): the domain
> called `gtm` here is `acquisition`; read `gtm.x` as `acquisition.x`.
>
> Superseded in part by [0047](0047-a-persons-acts-are-commands-at-a-terminal.md):
> a relationship is declared on a company, never on a person alone.

## Decided

**What is declared.** A person — never a run, never an agent — declares
that a subject reached a state, from a given moment, and may say why. Two
kinds of state, by the rule of [0035](0035-what-a-domain-is.md):

- **A stage of the addressing motion**, in the addressing domain
  (`gtm.person_state`, `gtm.company_state`): `targeted`, `engaged`,
  `opportunity`. These exist only inside that motion.
- **A relationship**, in `relations` (`relations.relationship`):
  `customer`, `former_customer`, or `none`. True whether or not anyone is
  prospecting, and read by whoever needs it — support, finance, product.

`customer` and `lost` therefore leave the addressing domain's enum. `lost`
is written `former_customer` in `relations`: outside a funnel, "lost" also
reads as "the deal was lost", which is a stage of the motion, not a
relationship. `unknown` leaves too: with a history, a subject with no row
has no declared state, and a default value would say otherwise.

**When.** When the person learns it. The declaration carries the moment the
state became true (`at`, never in the future) and, separately, the moment
it was recorded. A meeting held on Tuesday and recorded on Thursday is an
opportunity from Tuesday.

**Kept, not overwritten.** Each declaration is a row, appended, never
updated — a trigger refuses it, as on `relations.touch` (0026). The current
state is the latest by `at`, read through a view the owning domain
publishes: `gtm.person_state_current`, `gtm.company_state_current`,
`relations.relationship_current`. A mistaken declaration is corrected by
another, which says why. Replaying the same declaration — same subject,
state and moment — keeps one row: the key is in the DDL.

**Recorded as a run.** Each declaration is its own run, with the person as
actor, as an acknowledgement is (0034). The schema refuses a declaration
whose actor is not a person, and one without its run.

**A touch says whether it was solicited.** `relations.touch` gains
`unsolicited`. `direction` cannot carry it: a reply to a support question
and a sales follow-up are both outbound. An inbound touch is never
unsolicited (a check refuses it); an outbound one says which it is, and
`recordTouch` has no default. Existing outbound touches become unsolicited
— the side that counts against a cap, so the migration fails closed. The
solicitation cap, when it is built, reads unsolicited touches only, so a
reply is never held back by a marketing cadence.

## Why a history

A stage overwritten in place answers "where is this person now" and nothing
else. Measurement asks "where was this person when the experiment reached
them", and a decision (core) must cite what it read; neither survives an
overwrite. The two state tables were one row per subject and written by
nothing, so the change costs no data — and the migration refuses to run,
rather than drop rows, on a database where something wrote them anyway.

## Not done here

- **The `customer` fact should one day be written by the domain that
  observes the payment, not declared by a person** in the domain that
  prospects. Until such a domain exists, a person declares it.
- **The protected set is unchanged.** Protection still reads customers from
  its source, live, failing closed (0031–0034). A declared relationship
  neither relaxes nor replaces it.
- **No exit stage.** An opportunity that does not close has no stage to go
  to; the motion's end is not decided here.
- **`company_state.last_touched_at` is gone.** Nothing maintained it; it is
  a query over `relations.touch`.

## Tension left open

`relations.company` says relationship status is a fact other systems own,
read on demand and never copied (doctrine 3). `relations.relationship`
stores one. What it stores is a person's declaration, which this system
does own — but where a CRM also holds the status, there are now two. Which
one a reader trusts is not settled here, and both texts stand until it is.

## Rules out

- A state overwritten in place.
- A run or an agent declaring a stage or a relationship.
- `customer` or a former customer as a stage of the addressing motion.
- An outbound touch that does not say whether it was solicited.

## Would reverse it

A source of stages the engine can read — a CRM's pipeline, read live — that
the operator trusts over their own declarations. Then the stage is a fact
another system owns, and doctrine 3 says read it, not keep it.
