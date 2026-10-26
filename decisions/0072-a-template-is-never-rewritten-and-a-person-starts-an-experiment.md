# 0072 — A template is never rewritten, and a person starts an experiment

Completes [0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md),
whose gate refuses a contact for an experiment that is not running only
when a lane approved it. Rests on
[0018](0018-measurement-reads-little.md), where a variant is what a metric
is read by, [0047](0047-a-persons-acts-are-commands-at-a-terminal.md),
whose form a person's acts take, and
[0064](0064-one-verb-reaches-a-person-and-carries-the-message.md), where a
template is one step of one variant.

## What was found

On `main` at `8fb9ba9`:
- **Nothing writes an experiment or a template.** The first run's script
  inserts both directly. Nothing moves an experiment's status either.
- **What was said is not on the template.** It is on the draft, its text
  frozen at approval by a trigger, then on the message the gate writes.
  What a template holds is a draft's provenance and the plan: `enrol` reads
  each variant's steps, channels, delays and subjects, and holds them
  against the provider's steps.
- **A draft cites its template** (`draft.template_id`), and so its variant
  and step. Deleting a template sets that to null: a draft would lose its
  source without a word.
- **A drafted person cannot change variant.** A draft is unique per
  experiment, person and step, whatever its variant; `enrol` refuses a
  person whose approved drafts come from two variants. A dropped draft
  still holds its key.
- **A variant is an arm of the experiment.** It is carried to the provider
  with the enrolment, back with the replies' attribution, and is what a
  metric is read by (0018).
- **The status conditions half the contacts.** The message gate refuses a
  lane's approval for an experiment that is not running, and writes a
  message a person approved for one in `draft` or `measuring`
  (`relations/runtime/message.ts`, *Not checked*).
- **A person cannot correct a draft at approval.** `approve()` takes a
  changed text, marks it `edited_before_approval` and resets the streak;
  `kernel-approve` does not offer it.

## Decided

**A template is never rewritten.** An update is refused in the DDL. While
no draft cites it, a person may withdraw it and record another at the same
step of the same variant: nothing has come out of it. Once a draft cites
it, it stays: `draft.template_id` restricts the delete, so the schema
refuses it, and a draft written at the same moment waits on the same row.

**A template is recorded by a person**, at a terminal, with `--by`, its
text shown whole before it is written: it is what every draft of its step
will say.

**A correction after drafting is a new variant, marked as one.** A
template recorded as a correction names the variant it corrects
(`template.corrects`); every step of a variant carries the same mark, held
in the DDL. It carries every step, since a variant is a whole plan, and it
reaches only the people not drafted yet. It is not an arm: those it
reaches were chosen by when they were drafted, not at random, and
comparing it with what it corrects as if they were randomised arms is the
false conclusion this system exists to prevent. Nothing in the kernel
reads by variant today: `readMetric` has no caller, and a variant reaches
a source only as a value passed through (0018). The first path that does
reads the mark, and keeps a correction out of a comparison with what it
corrects, or shows it beside it named as a correction — never compared in
silence.

**A drafted person is corrected at approval.** `kernel-approve` lets the
person reading a draft change its text before approving it. That is what a
reviewed lane means, and it is the only recourse for a person drafted from
a template since corrected. The edit is marked, and the streak goes back
to zero, as `approve()` already does.

**An experiment is recorded, then started, by a person.** Two acts, in
0047's form: at a terminal, `--by`, the slug typed again. Recorded, it is
in `draft`, and authorises no contact; its type must be one a domain
declares. Started, it is `running`: the act that authorises contact. A
start is refused for an experiment with no template.

**The gate refuses every contact for an experiment that is not running**,
whoever approved it. A start that the gate did not read would authorise
nothing, and the status would keep conditioning half the contacts. A
message tied to no experiment — an answer to a customer — is not
concerned.

## Not decided here

**Stopping.** A third act would take an experiment out of `running` — to
`measuring`, or `killed` — and must say what happens to what is in flight:
enrolments still running at the sequencer, approved drafts not yet
enrolled. Until a decision says it, no command leaves `running`, and the
gate above stops new contacts only for an experiment that never started.

## Rules out

- A template rewritten in place, or deleted under a draft.
- A correction measured as an arm.
- A contact authorised by an experiment no person started.

## Would reverse it

- **A draft that holds its own plan**, not its template's. A template could
  then be corrected without moving what an enrolment reads.
- **Drafts unique per variant.** A drafted person could then be moved to a
  correction, and the correction would reach them too.

## Not built yet

Everything above at merge, except `approve()`'s edit and its streak.
