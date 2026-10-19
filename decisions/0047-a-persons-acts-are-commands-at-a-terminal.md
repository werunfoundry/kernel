# 0047 — A person's declarations, lists and decisions are commands at a terminal

Completes [0036](0036-a-state-is-declared-and-kept.md),
[0037](0037-a-list-is-frozen-and-is-not-a-permission.md) and
[0039](0039-events-are-pulled-and-kept-decisions-are-a-persons.md), whose
verbs had no caller but their tests. Supersedes in part 0036: a relationship
is declared on a company, never on a person alone.

## Decided

**Four commands.** The API refuses a person by construction (0040), so a
person's act is a command, as `kernel-acknowledge` and `kernel-erase` are:

| Command               | Domain        | Writes through        |
| --------------------- | ------------- | --------------------- |
| `kernel-stage`        | `acquisition` | `declareStage`        |
| `kernel-relationship` | `relations`   | `declareRelationship` |
| `kernel-list`         | `acquisition` | `constituteList`      |
| `kernel-decide`       | `core`        | `recordDecision`      |

`kernel-list` is in `acquisition` because it reads a sourcing run's result.
`kernel-relationship` is in `relations`, never in `acquisition`, and a test
reads `acquisition`'s sources to hold that.

**`relations` is not where constraint 6 is satisfied.** The constraint
(`docs/domains.md`) says the customer fact is written by the domain that
observes the payment. Neither `relations` nor `acquisition` observes one.
`relations` is a neutral place: it keeps the fact out of the domain that
prospects, and that is all. When a domain that observes the payment exists,
`customer` moves there.

**Who acts: the person names themselves, and is not verified.** `--by <who>`,
required, is written as `actorType: human` and `actorId` as given — the core's
three columns, nothing more (doctrine 5). What is verified is that a person is
at the keyboard: with no terminal, nothing is written; and the subject's key
is typed again before anything is. No flag skips either. `--by` is checked
against no register: the kernel has none, and building one is the identity
system doctrine 5 rules out. A verified actor is 0040's open question; the
first case that needs a person over the API settles it — not this one.

**A subject is named by its key**, found through the unique indexes
`relations` already keeps — `--person <email>`, `--company <domain>`, or the
row id — and an experiment by `--experiment <slug>`. A key that names nothing
is refused: a command never creates what it declares about (as 0039 for a
person in an event).

**A relationship is declared on a company — an approximation of constraint
3, not constraint 3.** The constraint says being a customer is a property of
a person's affiliation to a company, bounded in time. That affiliation does
not exist: `relations.person.company_id` is one reference, with no dates. The
company is the closest subject the record has. Three things hold, and only
the second is this change:

1. the schema still accepts a relationship on a person;
2. the code refuses one — `kernel-relationship` takes `--company` only, and
   `declareRelationship` refuses a person subject, whoever calls it;
3. the real fix is the bounded affiliation, a piece of work of its own, with
   its migration.

**A declared relationship feeds no protection.** 0041 already decided it:
protection reads the protected set from the source the instance binds — a
fact derived from billing — and never a declaration. This decision does not
reopen that; it builds the first gesture that writes a declaration, so it
says what that gesture is: an operator's annotation, read by whoever reads
relationships, and never a protection. Declaring a company a customer stops
no run, and withdrawing it releases none. What it costs: a customer signed
but not yet billed is not protected by being declared. A test reads the
sources of every run that reads protection and refuses any reach to the
relationship's table, view or functions.

**The moment is said, never assumed.** `--at` is required: an ISO time, or a
date read as that day at 00:00 UTC. Defaulting it to now would merge the two
moments 0036 keeps apart — when it became true, when it was recorded — and
would turn every re-run into a new row.

**Idempotence, verb by verb.**

- *Stage, relationship.* The same subject, state and moment is one row: the
  key is in the DDL (0036). The command reads the current state first: if it
  is that same declaration, nothing is written and it says so. If the subject
  already stands in that state from another moment, the command refuses and
  writes nothing: a second row would only move "since when". A different
  state is a new row; the history keeps the old one.
- *List.* `--key` is required and unique in the DDL (0037). An existing key is
  refused before anything is written, naming when, by whom and with how many
  members the list was constituted. `constituteList`'s own answer still holds
  a race.
- *Decision.* **Not idempotent, and exempt from doctrine 4 — on purpose.**
  Each run of the command is one decision. Doctrine 4 asks a uniqueness key of
  every write path that *can replay*: a retry, a redelivered callback, a job
  run twice — a write repeated with nobody choosing to repeat it. A person
  who runs `kernel-decide` again, at a terminal, and types the experiment's
  slug again to confirm, is not replaying a write; they are concluding a
  second time, and two conclusions are two acts. Before writing, the command
  shows the decisions already recorded on the experiment. A mistaken one is
  corrected by another that says so; the table is append-only (0039). The
  exemption covers this command only: a decision written by any path that
  can retry — a queue, a schedule, the API — needs its key first, and a
  migration with it.

**A list is made from a run's result or from a hand selection, never from a
live query.** 0037 froze it and kept the query beside it as a record; that
stands.

- `--from-run <runId>`: the people a live sourcing run kept. The query kept is
  `{ from: "acquisition.sourcing_result", runId, outcome: "kept" }`;
  replaying it gives the same people, because a run's result does not move.
- `--from-file <path>`: one email or domain per line, blank lines and `#`
  comments aside. Every line must name a recorded subject, or nothing is
  written. The query kept says it was a hand selection, and the file's name
  and digest.

A selection that names nobody is refused: an empty list targets nothing,
and is not evidence of anything. The members are shown by the address
recorded, before the key is typed again.

The list is constituted in its own run, with the person as actor; the source
run is named in the query, not as the list's run. **The command reads no
opt-out and no protection**, and filters nobody: a list filtered at
constitution would read as cleared to contact. Consent and protection are
evaluated at sending (0037; constraint 9).

**A decision carries the readings the person read.** `--conclusion`, `--why`
optionally, and either `--readings <file.json>` — an array of `{ metric,
value, readAt }`, each checked for shape — or `--no-readings`, written as
`[]`. Neither is refused: an empty set is said, not defaulted. The command
computes nothing and reads no metric (0039).

**A dry run.** Each command takes `--dry-run`: it resolves the subject, shows
what it would write, and writes nothing — no run either.

## A person who declares the wrong state cannot always correct it

These commands are for people, and people make mistakes. 0036's model —
append-only, current state is the latest `at` — leaves some of them with no
way back. Named, with the workaround where there is one:

| Mistake                                         | Relationship                                         | Stage                                                |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Wrong state                                     | Declare the right one, at or after the wrong moment. | Same.                                                |
| A state where there should be none              | Declare `none`.                                      | **No workaround**: a stage has no neutral value.     |
| Right state, wrong moment                       | **No workaround.**                                   | **No workaround.**                                   |
| Wrong subject                                   | Declare `none` on it.                                | **No workaround.**                                   |

The workaround for a wrong state costs the moment: the correction is current
only from a moment at or after the mistake's, so "since when" reads later
than it was. A right state at the wrong moment cannot be fixed: the command
refuses the same state again, and the schema would make an earlier moment
history, never current. A row can be deleted in SQL — the triggers refuse an
update, not a delete — but that leaves no run and no trace, and no command
offers it. Erasing the person removes their stages with everything else, and
is not a correction. Each command says this before it asks for confirmation.
**The SQL delete is a hole, not a workaround.** In a record kept by
appending, a row that disappears without a run is exactly what the record
exists to prevent: what it said on a given date can no longer be read back.
It is named here so that nobody mistakes it for the way to correct.

**What comes next is a retraction verb.** A person retracts a declaration:
a new row, in its own run, naming the declaration it retracts and why, and
the published view stops reading the retracted one. It supersedes and never
erases, so it is compatible with appending only: the mistake and its
retraction both stay, each with who and when. It covers every line of the
table — the wrong moment, the wrong subject, a stage where there should be
none — without a neutral stage. It changes 0036's model and its views, and
needs a migration, so it is its own decision; it is not built here, and a
correction by deletion is not to be built in its place.

## Rules out

- A declaration, a list or a decision written without a terminal.
- A relationship declared on a person alone.
- The customer fact written from `acquisition`.
- Protection read from, or relaxed by, a declared relationship (0041).
- A moment defaulted to now.
- A list filtered by consent or protection when it is made; a list
  re-evaluated.
- A command creating the subject it declares about.
- A decision written by a path that can retry, without a uniqueness key.

## Noticed, not fixed here

1. **`relations.relationship` still accepts a person in the schema**; a check
   would hold the rule there, and is a migration. The bounded affiliation
   makes it moot.
2. **There is no affiliation.** A person who changes company loses where
   they were (0041 says what that costs).
3. **Nothing reads a list.** Enrolment reads a sourcing run (0032);
   `core.experiment.targets` names a list by convention, unchecked.
4. **The README's account of stages is stale.** It still describes
   `acquisition.lifecycle_stage` as an enum holding `customer` and `lost`,
   which 0036 replaced.
5. **Two triggers for one kind of act.** A declared stage or relationship,
   a list, a decision and an erasure open their run as `manual`; an
   acknowledgement, as `cli` — as the commands that run unattended do. All
   are a person at a terminal, and each verb sets its trigger itself rather
   than being told how it was reached.

## Would reverse it

A verified actor identity (0040): `--by` gives way to it. A domain that
observes the payment: `customer` is written there. A bounded affiliation:
the relationship moves onto it, and the company-only rule goes. A retraction
verb: the table of mistakes above empties, and the commands stop warning.
