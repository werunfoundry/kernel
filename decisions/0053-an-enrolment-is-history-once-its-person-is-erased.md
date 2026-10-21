# 0053 — An enrolment is history once its person is erased

> Completed by [0056](0056-erasure-stops-the-person-before-it-forgets-them.md):
> the anonymised row follows a suspension, or a stop a person attested.

> Not built, on `main` at `350656e`: the suspension *Decided* says comes
> first. Erasure calls no adapter, and anonymises a row the provider may
> still be sending to (0056, *What was found*).

Completes [0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md),
which left this open, and [0049](0049-erasure-reaches-a-person-by-keys-and-says-what-it-does-not.md),
whose `text` it narrows. Reverses the answer `acquisition` gave
`enrolment` since 0040: `delete`.

## Decided

**Erasure anonymises an enrolment row; it no longer deletes it.** What
keeps an erased person from being contacted again is the suppression
register (0052), not this row. That was already true: erasure deleted the
row, so the row never stopped a recontact. What is left is the history of
what a run did — this person, in this sequence, through this company,
enrolled, refused or suspended, when and by which run — and 0049 decided
what is done with history: it says what happened, not who.

**Deleting it would also destroy what 0051 made it hold.** A suspended
row is the kernel's only record that a person was stopped, when, by which
run, and how. Erasure suspends before it anonymises (0051's callers). The
anonymised row is the proof that it did.

**What the row keeps, and what it loses.** It keeps the sequence, the
channel, the provider, the company, the state, the dates, the runs, and the
suspension's method and declared costs. It loses:

- **`person_id`**, emptied. The column becomes nullable for that one case,
  and only for it (below); its reference to the person stays `restrict`,
  which an empty column does not hold back;
- **`idempotency_key`**, replaced by a value derived from nothing. It is a
  hash of the person's keys, so it can be tested against an address, which
  0049 rules out in a history row;
- **`refusal`**, replaced by a fixed sentence where it holds one: it is the
  provider's answer, in free text;
- **`suspension_read_back`**, replaced by a fixed document where it holds
  one. It is what the provider returned when the suspension was read back,
  and that may name the person in clear.

**`text` writes only where the column holds a value.** 0049's `text`
wrote its sentence on every row it reached. Both rules that use it today
write into columns that are never empty, so nothing they do changes. An
empty column now stays empty, so a rule cannot invent a sentence where
there was nothing — and cannot fill a column a check requires to be empty,
as `suspension_read_back` is on a row that is not suspended. Into a `jsonb`
column, the fixed value is a JSON document.

**An enrolment is born naming a person, and loses them only once they are
erased.** A row cannot be inserted without `person_id`, and `person_id` can
be emptied only if, when the transaction commits, the person it named no
longer exists or no longer holds an address or a profile id — the two ends
relations' erasure gives a person. The check is deferred to the commit,
because erasure empties this row before it removes the person, in the same
transaction. It makes the circumstance certain, not the writer: the schema
cannot tell erasure from another writer that erases the person in the same
transaction, and does not need to, because that is what erasing is.

**A suspended row's record changes once, as its person leaves.** 0051's
trigger freezes a suspended row's record. It now lets the read-back be
replaced by the fixed document, and nothing else, in the update that empties
`person_id` — which the check above allows only as the person is erased.
Every other change to a suspended row's record is still refused.

## What it does not reach

- **What the provider holds** of the enrolment. Erasure suspends the
  person there, by the way the adapter declared (0051), and that way's costs
  say what the provider keeps.
- **A row written before the person was recorded** does not exist: an
  enrolment is born naming a recorded person, and the schema refuses one
  that does not.

## Rules out

- Deleting an enrolment row to erase who it was about.
- An anonymised enrolment row that still holds a value derived from the
  person's keys, or the provider's words about them.
- A `text` rule that writes into an empty column.
- An enrolment inserted without a person, or emptied of one who still
  holds a key.
- Any change to a suspended row's record but the one that accompanies its
  person's erasure.

## Would reverse it

An enrolment row that cannot be read without knowing who it was about. It
would then be a row about the person, and deleted, as 0049 has it.
