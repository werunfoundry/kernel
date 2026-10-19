# 0048 — A run's trigger is the channel its command says

Completes [0047](0047-a-persons-acts-are-commands-at-a-terminal.md), and
corrects a fact it states.

## Erratum

0047, *Noticed, not fixed here*, item 5, says an erasure opens its run as
`cli`. It opened it as `manual`: `core/runtime/erase.ts` set it so. Among a
person's acts, only the acknowledgement opened its run as `cli`. 0047 is
merged and is not edited; the fact is corrected here, and 0047 points to it.

## Decided

**`run.trigger` says the channel, `actorType` says who.** A run reached from
a command line is `cli`, whoever stands behind it. `manual` said "a person
did this", which `actorType: human` already says, and said nothing about how
the run was reached — the one thing a trigger is for. The day a person acts
through another surface, only a trigger that names the surface tells the two
apart.

**The command passes its trigger to the verb; the verb never sets it.** A
verb does not know how it was reached. `kernel-inbound` already passes its
own (0039). `declareStage`, `declareRelationship`, `constituteSelection`,
`recordDecision` and `erase` now take a required `trigger`, and their
commands — `kernel-stage`, `kernel-relationship`, `kernel-list`,
`kernel-decide`, `kernel-erase` — pass `cli`. No value is written in a verb
any more, so none is left to drift. A test reads the commands and the verbs
to hold both halves; the commands that run as processes in the tests also
read their run back.

**This changes a production behaviour.** What these verbs write to
`core.run` goes from `manual` to `cli`. No test asserted `manual`, so no
assertion changes — which is exactly why it is written down here rather
than passing as a refactor.

## What stays, on purpose

- **Past runs keep `manual`.** The history is not rewritten: a run says what
  was recorded when it ran. Any reading of the run history knows both
  values — before 0048, a person's run at a terminal may read `manual`. It
  is a handful of rows.
- **`manual` stays in the enum.** `trigger_kind` is a Postgres enum, and an
  enum value cannot be dropped — only the whole type rebuilt and every row
  rewritten, which is the rewrite ruled out above. It stays, with no writer,
  for the rows that carry it. **Do not "clean it up".**
- **`acknowledgeUncovered` and `withdrawAcknowledgement` still set `cli`
  themselves.** The value is the right one; the structure is not. They are
  protection's, outside this change, and the next change to them passes the
  trigger in.

## Rules out

- A verb deciding its own trigger.
- `manual` written for a person at a terminal.
- Rewriting the trigger of runs already recorded.
- Dropping `manual` from `trigger_kind`.

## Would reverse it

A trigger meant to carry intent rather than channel. A new surface does not
reverse it: a person acting through an interface is a new channel, named as
one, not `manual`.
