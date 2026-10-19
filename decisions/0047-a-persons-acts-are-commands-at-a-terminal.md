# 0047 — A person's declarations, lists and decisions are commands at a terminal

Completes [0036](0036-a-state-is-declared-and-kept.md),
[0037](0037-a-list-is-frozen-and-is-not-a-permission.md) and
[0039](0039-events-are-pulled-and-kept-decisions-are-a-persons.md), whose
verbs had no caller but their tests. Supersedes in part 0036: a relationship
is declared on a company, never on a person alone.

## Decided

**Four commands, each in the domain that owns the table it writes.** The API
refuses a person by construction (0040), so a person's act is a command, as
`kernel-acknowledge` and `kernel-erase` are:

| Command               | Domain        | Writes through        |
| --------------------- | ------------- | --------------------- |
| `kernel-stage`        | `acquisition` | `declareStage`        |
| `kernel-relationship` | `relations`   | `declareRelationship` |
| `kernel-list`         | `acquisition` | `constituteList`      |
| `kernel-decide`       | `core`        | `recordDecision`      |

`kernel-relationship` is in `relations` and nowhere else: the customer fact
is not written from the domain that prospects (`docs/domains.md`, constraint
6). A test reads `acquisition`'s sources and refuses any reach to
`declareRelationship`, as one holds the acknowledgement's writers (0034).

**Who acts: the person names themselves, and is not verified.** `--by <who>`,
required, is written as `actorType: human` and `actorId` as given — the core's
three columns, nothing more (doctrine 5). What is verified is that a person is
at the keyboard: with no terminal, nothing is written; and the subject's key
is typed again before anything is. No flag skips either. `--by` is checked
against no register: the kernel has none, and building one is the identity
system doctrine 5 rules out. A verified actor is 0040's open question, and
the first case that needs a person over the API settles it — not this one.

**A subject is named by its key**, found through the unique indexes
`relations` already keeps — `--person <email>`, `--company <domain>`, or the
row id — and an experiment by `--experiment <slug>`. A key that names nothing
is refused: a command never creates what it declares about (as 0039 for a
person in an event).

**A relationship is declared on a company.** Being a customer is a property
of a relationship with a company, not of a person alone (`docs/domains.md`,
constraint 3). `kernel-relationship` takes `--company` only, and
`declareRelationship` refuses a person subject, so no other caller writes
one. A person's standing follows from the company they are at.

**The moment is said, never assumed.** `--at` is required: an ISO time, or a
date read as that day at 00:00 UTC. Defaulting it to now would merge the two
moments 0036 keeps apart — when it became true, when it was recorded — and
would turn every re-run into a new row.

**Idempotence, verb by verb.**

- *Stage, relationship.* The same subject, state and moment is one row: the
  key is in the DDL (0036). The command reads the current state first: if it
  is that same declaration, nothing is written and it says so. If the subject
  already stands in that state from another moment, the command refuses: a
  second row would only move "since when", and it writes nothing. A different
  state is a new row; the history keeps the old one.
- *List.* `--key` is required and unique in the DDL (0037). An existing key is
  refused before anything is written, naming when, by whom and with how many
  members the list was constituted. `constituteList`'s own answer still holds
  a race.
- *Decision.* **Not idempotent.** Each run of the command is one decision: a
  person concluding twice has acted twice. Before writing, the command shows
  the decisions already on the experiment and asks for its slug to be typed
  again. A mistaken decision is corrected by another that says so; the table
  is append-only (0039).

**A list is made from a run's result or from a hand selection, never from a
live query.** 0037 froze it and kept the query beside it as a record; that
stands.

- `--from-run <runId>`: the people a live sourcing run kept. The query kept is
  `{ from: "acquisition.sourcing_result", runId, outcome: "kept" }`;
  replaying it gives the same people, because a run's result does not move.
- `--from-file <path>`: one email or domain per line. Every line must name a
  recorded subject, or nothing is written. The query kept says it was a hand
  selection, and the file's name and digest.

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

## Rules out

- A declaration, a list or a decision written without a terminal.
- A relationship declared on a person alone.
- The customer fact written from `acquisition`.
- A moment defaulted to now.
- A list filtered by consent or protection when it is made; a list
  re-evaluated.
- A command creating the subject it declares about.

## Noticed, not fixed here

1. **`core.decision` has no uniqueness key** (doctrine 4). Adding one is a
   migration, and this change writes none.
2. **`relations.relationship` still accepts a person in the schema.** The rule
   above lives in the runtime; a check holding it in the DDL is a migration.
3. **There is no affiliation.** `relations.person.company_id` is one foreign
   key with no bounds in time: constraint 3's dated affiliation does not
   exist, and a person who changes company loses where they were.
4. **A current state's moment cannot be moved earlier.** The view takes the
   latest `at`, so the same state declared earlier never becomes current, and
   a stage has no neutral value to pass through.
5. **Nothing reads a list.** Enrolment reads a sourcing run (0032);
   `core.experiment.targets` names a list by convention, unchecked.

## Would reverse it

A verified actor identity (0040): `--by` gives way to it. A domain that
observes the payment: `customer` is written there, and `kernel-relationship`
declares only what that domain does not see (0036).
