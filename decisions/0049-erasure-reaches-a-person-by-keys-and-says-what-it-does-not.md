# 0049 — Erasure reaches a person by their keys, and says what it does not reach

> Superseded in part by [0055](0055-one-passage-reaches-a-person.md): the
> threshold is the first live contact through the passage; only the kernel's
> own sandbox, recognised by the module it resolves to, is spared.

Completes [0040](0040-an-http-api-and-erasure-declared-per-domain.md).

## What was found

Erasing people by hand found their data in four places, one at a time: the
person's row; the keys a sourcing run kept of them (`sourcing_result.person`,
and the keys inside `said`); the run's fingerprint of those keys
(`subject`), which anyone holding an address can recompute and test — so
pseudonymised data, not anonymous; and, outside the database, the output of
the commands that ran.

**0040 had a defect, not only a gap.** `kernel-erase` reached the first
place, and reached the second the wrong way: acquisition declared
`sourcing_result` as `delete`, so erasing a person **deleted the history of
what each run did** — the run's outcome for that person, its cost, the
company it targeted — instead of anonymising it. That is the opposite of
what the rule requires. It was not blocked by the `restrict` key, because it
deleted those rows before the person's. It also did not reach the rows that
name a person only by keys (people excluded, dry runs), nor `enrolment_skip`,
which keeps keys and a fingerprint the same way.

## Decided

**A row says what happened, not who.** Where a domain keeps the history of
what it did, erasure empties who it was about and keeps the rest: the run,
the company targeted, the outcome, the timestamps, what the provider said of
each key. The outcome is never changed. The foreign key to the person is set
to null; the row is not deleted. Rows that exist only to say something
about the person — a touch, a message, a state, a draft — are still deleted,
as 0040 declared.

**Each domain declares it, in its `domain.yaml`, as 0040 set.** The
vocabulary of `anonymise` grows by three answers, and a rule may reach rows
by keys as well as by id:

```yaml
- table: sourcing_result
  column: person_id                       # rows naming the person by id (0040)
  keys: person                            # and rows whose identity in this column shares a key with them
  do: anonymise
  columns: [person_id, person]            # emptied, as in 0040
  strip: { said: [key.value] }            # removed from each element of a JSON array; the status stays
  random: [subject]                       # replaced by a value derived from nothing
  text: { detail: "erased (decision 0049); the outcome stands" }
```

- **`random`** writes `erased:` and a fresh random UUID. Not a hash of the
  original under another algorithm or a secret salt: anything derived from
  the keys can be tested against them. The value still satisfies the
  column's `not null` and the run's uniqueness key.
- **`text`** writes a fixed sentence. `detail` is free text written from a
  provider's or a CRM's answer — `known to the CRM as <its id for the
  person>` is one — and the kernel cannot prove a given one clean. So on
  every row anonymised, not only where an id is known to be quoted:
  erasing too much costs a diagnostic on a row nobody reads again.
- **`enrolment_skip` is declared the same way**, reached by keys alone: it
  has no column naming the person by id. Its owner's logic is unchanged;
  only its answer to erasure is declared.
- **Reaching by keys is the core's, declared by the domains.** Before
  anything changes, the core gathers the person's keys: from the subject's
  own row, whose rule names the columns that hold them (`keyColumns: {
  email: email, social_profile_id: external_id }` for `relations.person`,
  networked keys as `<network>:<value>`, as 0013 records them), and from the
  identity of every row reached by id. A row whose identity shares one key —
  kind, network and value, compared as the vocabulary says — is reached, and
  its keys join the set, until no new key is found. Every kind matches, phone
  included: wrongly reaching a row empties a history row of its keys, while
  missing one leaves a person's data where it was.
- **The gathering is a transitive closure, and it is not bounded.** A key
  two people share — a generic address, a switchboard number — carries it
  from one to the other: erasing A reaches B's rows through the key they
  share, and C's through a key B shares with C. Nothing in the core stops
  the chain, because nothing can tell a person's key from a shared one.
- **What guards against that surprise is the plan.** `--plan`, and the
  confirmation, show for each rule the rows reached by id and by keys, and
  what is not reached. A count by keys larger than one person's history is
  the sign of a chain. The plan is to be read before the id is typed again,
  not skimmed: typing it confirms what the plan says, not only who.

**The operational layer is not treated, and the command says so.** The
plan, and every erasure, end with what it did not reach:

1. **Backups** of the database. They expire on the instance's retention; a
   restored backup brings the erased back, and the erasures are run again.
   The kernel keeps no register of who was erased — that register would
   itself name them. An instance that restores backups keeps one.
2. **Execution logs** — the output of the commands. `kernel-source` prints
   each person it looked at; wherever the instance keeps that output, its
   retention is the instance's.
3. **Working copies** — dumps, exports, copies of the database, target
   lists in the instance.
4. **In the database, not reached by this decision**: `core.event`
   payloads (below), and `core.run.error`, free text that may quote a
   provider's answer.
5. **The opt-out** (below).

The kernel owns none of 1–3 and cannot see them: they live where the
instance runs (doctrine 8). A command that claimed to cover them would be
worse than one that says it does not — protection that is not there,
looking as if it were (doctrine 6).

## The opt-out does not survive an erasure

The opt-out is a column of the person's row (`relations.person.opted_out_at`,
global by 0041). Erasing deletes that row — or, when a kept row still points
at it, empties every key it is matched by — so nothing can recognise the
person again. **A person who asked to be erased and not contacted can have
one of the two today, not both**: a later sourcing run that finds them again
records a new person, who has not opted out. The CRM's exclusion (0031)
holds them only if the instance's CRM still knows them, and that is the
instance's, not the kernel's.

This is a hole, named here, not closed. The command says it, before the
confirmation and on the plan. Closing it is a **suppression entry kept under
a legal basis** — `keep` in 0040's vocabulary — and that entry must be
derivable from the address, or it recognises nobody. It is the one place
where derivability is the purpose, and it is decided on its own: what it
holds, for how long, and on which basis.

**That decision starts from a contradiction, not a gap.** To recognise
someone, the suppression entry must be derivable from their address: a
later run computes the same value from the address it finds and compares.
This decision rules out, for every row an erasure leaves, any value
derivable from the keys — because a derivable value can be tested against
an address someone holds, which is exactly what makes a fingerprint
personal data. The two requirements are the same property, asked for in
one place and forbidden in the other. The decision to come does not choose
a cleverer hash: whatever recognises a person can be tested against them.
It decides where derivability is allowed, under which basis, and what then
stands in the register of who asked not to be contacted — knowing that
this register names them.

**It is due at the same threshold as erasure itself: before the first real
send.** While nothing reaches a person, an erased person found again is
recorded and nothing more; once something can, they can be contacted
again. That point is not 0050's: its sending path hands over to a stub,
and no command calls it. It is already reachable today: `kernel-enrol
--live`, bound to a real sequencer, hands people to a provider that sends.
So the threshold is the first live enrolment into a real sequencer, or the
first real hand-over wired to 0050's path, whichever comes first.

## `core.event`: not reached, and the cheaper way out

The payload is the inbound event as the source gave it (`{ ...e }` in
`acquisition/runtime/inbound.ts`): its id, type and time, `attribution`,
`detail`, and `subject` — the person's **keys**, embedded. The contract
carries no body. Nothing reads `payload.subject` back.

A foreign key from the event to the person cannot exist: the core references
no domain (doctrine 2). But the reference already exists the other way.
Beside the event, inbound writes a `relations.touch` that names the person by
`person_id` and is unique on the same `(provider, provider_event_id)` as the
event — and erasure already deletes it. So **an event that carried no keys
would be reached by erasure without being rewritten**: who it was about lives
in the touch, and is erased there.

What that leaves, for the decision to come: an event about someone not
recorded, or on a channel no domain declares, has no touch, and its keys are
the only link; and the events already written keep theirs. The first is a
choice of what inbound keeps; the second is a one-time rewrite of past rows,
with the trigger lifted once and only there, as relations lifted the
touch trigger once for one backfill (its migration 0003). Both
are smaller than lifting append-only for every erasure, and smaller than
deleting observations. Neither is this decision.

## Rules out

- Deleting a history row to erase who it was about; changing its outcome.
- A replacement for a key or a fingerprint, in a history row, that is
  derived from it.
- An erasure silent about what it leaves, the opt-out included.

## Would reverse it

A history row that cannot be read without knowing who it was about — then
it is a row about the person, and is deleted. The suppression entry does not
reverse it: it is a row of its own, kept under a basis, not a history row
made derivable again.
