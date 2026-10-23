# 0070 — Once an erasure has run, the one reader holds what the provisional guard held

Supersedes in part [0055](0055-one-passage-reaches-a-person.md), the
provisional guard of its section 4: a live enrolment is no longer refused
because an erasure has run. Rests on
[0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md), whose
register keeps an objector's keys past their erasure.

## What was found

- **The guard was written for a reader that did not exist.** 0055 §4 put it
  in place "until the passage exists"; the command said why: until 0055's
  reader reads 0052's register. #125 built that reader. Every read of the
  objection goes through it, and it reads `opted_out_at` and the register
  for every key in hand.
- **The threshold the guard stood in for is held by that reader.** 0055 §4
  refuses a live contact "unless the reader answers from both the record
  and the register: the register exists, and every secret version is
  present". The reader answers *cannot answer*, and the run stops, when a
  declared version's secret is missing or an entry is keyed under a chain
  whose secret is not held. A register it cannot read throws. An instance
  that declares no version to write with does not boot.
- **The reader is asked before the one contact verb.** On `main` at
  `d067a65`, the sequencer's `enrol` is the only contact verb called
  (`runtime/enrol.ts`, `enrol`); the hand-over is withdrawn (0064 §1). The
  enrolment reads the objection for every person before it, and the message
  gate reads it again, under lock, before the call.
- **Measured, with the guard taken out.** In `try-instance`, a person who
  objected was erased through `kernel-erase`, recorded again by the same
  address, and put on a list with a witness, each with an approved draft. A
  live enrolment enrolled the witness and skipped her: "objected before an
  erasure; the register holds it". With the register's read also taken out
  of the reader, it enrolled both, and the sequencer held her. The reader is
  what stood between them; the guard only added a refusal of everyone else.

## Decided

**The provisional guard is removed**, from `kernel-enrol` and from the
enrolment's runtime. After an erasure, a live enrolment is held by what
holds it before one: the reader, for every person, and the run stopped
when the register cannot be read.

**`try-instance` checks what replaced it.** After its erasure, the erased
objector found again is skipped by the register, and a witness is enrolled
live.

**Why the threshold does not keep it.** 0055 ties the guard's removal to
`clear`'s threshold. The threshold refuses a live contact while the reader
cannot answer from the record and the register, and the reader already
refuses in exactly that case, at the one place a contact is made. What
`clear` would add is not a condition on the register. It is one passage for
every contact verb, the checks that hold a third path out, and a dry run
through the gate. The guard held none of those: it refused one verb, after
an erasure, whoever was asked about. Its going weakens none of them.

## What stays 0055's, and is not built

- The passage: `clear` and `reach`, the clearance's type, the run-time
  refusal, and the two checks. A third path to a person is held out by
  review, not by code.
- A dry run through the message gate, the known defect written at the top of
  `runtime/enrol.ts`.
- The sandbox, moved into the kernel's package.

## Rules out

- A live enrolment refused because an erasure ran, for people the register
  holds nothing on.

## Would reverse it

- **A path that reaches a person without asking the reader.** Until the
  passage holds it by code, such a path needs a guard of its own.
- **A reader that answers *none* when it cannot read the register.** The
  threshold would no longer be held, and a guard would be needed again.
