# 0050 — The sending path, end to end, with its hand-over stubbed

> Completed by [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
> the sends a sequencer makes on its own get a verb, the touches pull.

> Completed by [0055](0055-one-passage-reaches-a-person.md):
> the single gate the first defect called for is the one passage.

> Superseded in part by [0064](0064-one-verb-reaches-a-person-and-carries-the-message.md):
> the hand-over is withdrawn with run 2's steps 6 to 8, and the cap is
> judged ahead, at the enrolment.

Completes [0027](0027-a-draft-waits-on-its-lane.md), whose `sent` and
`failed` had no writer; [0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md),
whose gate had no caller but its tests; and
[0047](0047-a-persons-acts-are-commands-at-a-terminal.md), which noticed that
nothing reads a list. Supersedes in part 0038: the solicitation cap reads
touches.

## Decided

**The sending path goes from a frozen list to a recorded touch, and nothing
in it reaches a provider.** Where the sequencer would be called, the path
calls a hand-over its caller gives. This package ships no implementation of
it, and no command calls the path: only its tests and `try-instance` do, each
with a stub of its own. Sending for real is a later decision.

**It is two runs with a person between them**, because a `reviewed` lane
waits on a human approval (0027), and an approval is a person's act, not a
step of a run. Both live in `acquisition`, beside the draft and the template
they read; the list, the message and the touch are written through
`relations`' own functions, never into its tables (doctrine 2).

### Run 1 — `acquisition.draft`: from a list to drafts

| Step | What is evaluated | What is not |
| ---- | ----------------- | ----------- |
| 1. **Read the list** by its key, through `readList`. | It exists and is sealed. A company on it names nobody to write to: reported, skipped — finding its people is sourcing's work (0031), not sending's. | Consent, protection, cadence. A list is a selection, never a permission (0037; constraint 9). |
| 2. **Compose** each person's text from the template, with the composer the caller gives. | Nothing: the engine does not write copy (0027). | — |
| 3. **Propose the draft** (`propose`, 0027). | The experiment exists; the person has not opted out (nothing is drafted for them); the lane — a person approves on `reviewed`, the lane on an earned `autonomous` or a licensed `reactive` (0042). | Protection: a draft reaches nobody. |

**Between the two: a person approves** (`approve`, 0027). What is evaluated
is the content.

### Run 2 — `acquisition.send`: from approved drafts to touches

For the experiment's drafts whose person is on the list, approved or queued
— a queued one is a hand-over an earlier run did not confirm:

| Step | What is evaluated | On refusal |
| ---- | ----------------- | ---------- |
| 4. **Read protection**, once per run, fresh, failing closed, through `readProtection` as enrolment does (0019, 0044). Unchanged. | The person's addresses, and the company `relations` recorded for them (see *The missing affiliation*). | Unreadable or stale: the run stops before anything is written. A protected person's draft is dropped by the system, with the reason. |
| 5. **Write the message** (`writeMessage`, 0038). Key: `acquisition.draft:<draft id>`, so a replay is one message. | Consent (the global opt-out); cadence (the cap, below); lane (the approval). | The draft stays approved, and the report names every reason. A cadence refusal is *not yet*: a later run may pass once the window has moved. |
| 6. **Queue the draft** (`queue`, 0027). | The experiment is running; the opt-out, read again. | Opted out: dropped by the system. Not running: stays approved. |
| 7. **Hand over**, with the message's key as the idempotency key. | Nothing, by the kernel: this is the seam. | Not retryable: the draft is `failed`, and says why. Retryable: the run stops, `partial`, the draft stays queued and the next run resumes it. |
| 8. **Record the touch and settle the draft**, in one transaction: an outbound touch (`recordTouch`) that names its message, under the provider's own event id, and the draft queued → `sent`. | — | — |

**Whether a send is unsolicited is said by the caller of run 2, with no
default**, as `writeMessage` asks it. A cap is required when it is.

**The message is written before the hand-over, the touch after it** (0038,
*Would reverse it*). A message with no touch is a hand-over nobody
confirmed: a crash, a failed hand-over, or a queue refused between steps 5
and 6. Replaying the run resumes a queued one: `writeMessage` returns the
same message, the hand-over is idempotent on its key, and the touch is held
once by its key and by its message.

### Two columns, in one migration slot

- **`relations.touch.message_id`** — the message a touch confirms the
  hand-over of. Null for every other touch: an inbound one, a pulled one, a
  send the sequencer made on its own. Unique where set: a message is handed
  over once, and that protects the send path's touch write. Cascade: only an
  erasure deletes a message, and it deletes the person's touches with it.
  Not `provider_event_id`, which is the provider's id for its event: a
  kernel key stored there would make the name lie, and break on the first
  real one.
- **`acquisition.draft.failure_reason`** — why a `failed` draft failed,
  required by a check when it is.

Two files, not one: a migration belongs to the layer whose schema it
changes (0002), and `relations` cannot migrate `acquisition`'s table. They
land in the same pull request, which holds the slot: decision 0049 needs no
migration, and if that changes, it waits for this one.

### The cap reads touches — superseding 0038 in part

0038 counts the unsolicited *messages* to the person in the window.
Constraint 4 says the cap is read from touches. From now on it counts **the
unsolicited outbound touches to the person in the window, plus the unsolicited
messages in the window that no touch names yet**.

- A message and its touch count once.
- A message handed over and never confirmed still counts, so a crash between
  hand-over and touch lets no second message through. It errs on the side of
  refusing.
- A touch any writer records — a send the sequencer made on its own, once
  something records it — counts without having passed through this gate.

## The three known defects

1. **Nothing read a list.** Run 1 does. **Enrolment still reads a sourcing
   run (0032), and is not changed here.** Enrolment hands a person to a
   sequence that sends on its own, and every one of those sends bypasses
   this gate. That bypass is exactly what a single gate will have to close:
   that work exists, and comes after this decision.
2. **The cap does not count what the sequencer sends on its own.** Still
   true, and now one step from closed: the cap reads touches, and nothing
   records those sends as touches — the inbound pull writes inbound touches
   only (0039), enrolment writes none. Until a source reports each send and
   it is recorded as an outbound unsolicited touch, a person enrolled in a
   sequence and also written to by this path can receive more than the cap.
3. **The opt-out is global, and closes even an invoice (0041).** Unchanged.
   This path sends what `acquisition` sends, which the global opt-out is right
   to refuse; what it costs a domain that invoices, 0041 already says.

## The missing affiliation

**Protection at sending judges a list member by the company `relations`
recorded, not by where they work now.** For enrolment, 0041's guarantee
holds because enrolment reads the target list, whose answer is current. A
list holds people, and nothing in the record knows where a person works
*now*: a person who moved to a customer, with neither their recorded company
nor their address changed, is not seen.

That is not a limit of its own. It is the root defect 0047 names (*Noticed*,
2): **there is no person–company affiliation bounded in time.**
`relations.person.company_id` is one reference, with no dates, filled once
and never overwritten. Two symptoms of the one missing structure:

- a relationship declared on a company, as an approximation of a person's
  affiliation (0047, constraint 3);
- protection at sending that reads a company which may no longer be the
  person's.

Both go when the bounded affiliation exists. Asking the target list per
member instead would be a change to protection, outside this decision.

## Limits this path has

- **A send the provider later reports under its own id is counted twice** —
  once as the message's touch, once as the pulled one, which names no
  message. Too strict, never too loose; the real hand-over decides how a
  pulled send finds its message.
- **The channel a sent touch records is its template's, checked against no
  declared vocabulary.** The inbound pull refuses an undeclared channel
  (0039); this path does not yet. The real hand-over, which is bound per
  channel (0015), is where an undeclared one is refused.

## Noticed: a comment described a cap the code did not have

The comment on `touch.unsolicited` said, in the present tense, that the
solicitation cap reads unsolicited touches. The code counted messages, and
nothing read the column. The decisions were accurate: 0036 announced the cap
that way for when it would be built, and 0038 built it on messages and said
so. The comment was not, and nothing checks that a comment describes what
the code does. This decision makes the comment true; it proposes no check.

## Rules out

- A send whose consent or protection was read when its list was made.
- A message handed over before it is written, or a touch recorded before the
  hand-over.
- A cap that counts only what passed through the gate.
- A kernel key stored in a provider's field.
- A hand-over, a provider call or a command shipped by this decision.

## Would reverse it

A provider that cannot take a send before reporting it (0038, *Would reverse
it*): the message would record what happened rather than gate what may. A
bounded affiliation: protection at sending reads it, and *The missing
affiliation* goes.
