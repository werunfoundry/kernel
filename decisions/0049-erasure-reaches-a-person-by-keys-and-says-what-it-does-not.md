# 0049 — Erasure reaches a person by their keys, and says what it does not reach

Completes [0040](0040-an-http-api-and-erasure-declared-per-domain.md).

## What was found

Erasing people by hand found their data in four places, one at a time: the
person's row; the keys a sourcing run kept of them (`sourcing_result.person`,
and the keys inside `said`); the run's fingerprint of those keys
(`subject`), which anyone holding an address can recompute and test — so
pseudonymised data, not anonymous; and, outside the database, the output of
the commands that ran.

`kernel-erase` as 0040 built it reached the first, and reached the second
wrongly: it **deleted** every `sourcing_result` row that names the person by
id — the history of what a run did — and did not reach the rows that name
them only by keys (excluded people, dry runs), nor `enrolment_skip`, which
holds keys and a fingerprint the same way.

## Decided

**A row says what happened, not who.** Where a domain keeps the history of
what it did, erasure empties who it was about and keeps the rest: the run,
the company targeted, the outcome, the timestamps, what the provider said of
each key. The outcome is never changed. The foreign key to the person is set
to null; the row is not deleted.

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
  text: { detail: "erased (0049); the outcome stands" }
```

- **`random`** writes `erased:` and a fresh random UUID. Not a hash of the
  original under another algorithm or a secret salt: anything derived from
  the keys can be tested against them. The value still satisfies the
  column's `not null` and the run's uniqueness key.
- **`text`** writes a fixed sentence. `detail` is free text written from a
  provider's or a CRM's answer — `known to the CRM as <its id for the
  person>` is one — and the kernel cannot prove a given one clean.
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
- **The plan says it all.** `--plan`, and the confirmation, show for each
  rule the rows reached by id and by keys, and what not reached means.

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
4. **In the database, not reached by this decision**: `core.event` payloads,
   which name the person by keys and are append-only — rewriting one needs a
   migration that lifts the trigger for erasure alone, and deleting one
   loses an observation; and `core.run.error`, free text that may quote a
   provider's answer.

The kernel owns none of 1–3 and cannot see them: they live where the
instance runs (doctrine 8). A command that claimed to cover them would be
worse than one that says it does not — protection that is not there,
looking as if it were (doctrine 6).

## Rules out

- Deleting a history row to erase who it was about; changing its outcome.
- A replacement for a key or a fingerprint that is derived from it.
- An erasure silent about what it leaves.

## Would reverse it

A suppression requirement — recognising an erased person so that a later
run does not contact them again. It needs a derivable key, which is exactly
what this rules out, and is decided on its own. Until then, an erased person
found again by a later run is a new person: nothing remains to recognise
them, by construction.
