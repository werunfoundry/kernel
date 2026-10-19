# 0050 — The sending path, end to end, with its hand-over stubbed

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
| 4. **Read protection**, once per run, fresh, failing closed, through `readProtection` as enrolment does (0019, 0044). Unchanged. | The person's addresses, and the company `relations` recorded for them. | The run stops before anything is written, as enrolment's does. A protected person's draft is dropped by the system, with the reason. |
| 5. **Write the message** (`writeMessage`, 0038). Key: `acquisition.draft:<draft id>`, so a replay is one message. | Consent (the global opt-out); cadence (the cap, below); lane (the approval). | The draft stays approved, and the report names every reason. A cadence refusal is *not yet*: a later run may pass once the window has moved. |
| 6. **Queue the draft** (`queue`, 0027). | The experiment is running; the opt-out, read again. | Opted out: dropped by the system. Not running: stays approved. |
| 7. **Hand over**, with the message's key as the idempotency key. | Nothing, by the kernel: this is the seam. | Not retryable: the draft is `failed`. Retryable: the run stops, `partial`, the draft stays queued and the next run resumes it. |
| 8. **Record the touch and settle the draft**, in one transaction: an outbound touch (`recordTouch`) naming the message by its key, and the draft queued → `sent`. | — | — |

**Whether a send is unsolicited is said by the caller of run 2, with no
default**, as `writeMessage` asks it. A cap is required when it is.

**The message is written before the hand-over, the touch after it** (0038,
*Would reverse it*). A message with no touch is a hand-over nobody
confirmed: a crash, a failed hand-over, or a queue refused between steps 5
and 6. Replaying the run resumes a queued one: `writeMessage` returns the
same message, the hand-over is idempotent on its key, and the touch's own
key holds it once.

### The cap reads touches — superseding 0038 in part

0038 counts the unsolicited *messages* to the person in the window.
Constraint 4 says the cap is read from touches. From now on it counts **the
unsolicited outbound touches to the person in the window, plus the unsolicited
messages in the window that no touch confirms yet** — a message whose own
touch, recorded under its key, is not there.

- A message and its touch count once.
- A message handed over and never confirmed still counts, so a crash between
  hand-over and touch lets no second message through. It errs on the side of
  refusing.
- A touch any writer records — a send the sequencer made on its own, once
  something records it — counts without having passed through this gate.

**No migration.** `touch.unsolicited` exists (0036); the touch index on
(person, occurred_at) serves the read; the link from a touch to its message
is the message's key, written as the touch's `provider_event_id` by the one
path that records it.

## The three known defects

1. **Nothing read a list.** Run 1 does. **Enrolment still reads a sourcing
   run (0032), and is not changed here**: enrolment hands a person to a
   sequence that sends on its own, past this gate, and reading a list
   instead would not bring those sends through it. Moving enrolment onto
   lists is its own change, and would carry limit 4 below with it.
2. **The cap does not count what the sequencer sends on its own.** Still
   true, and now one step from closed: the cap reads touches, and nothing
   records those sends as touches — the inbound pull writes inbound touches
   only (0039), enrolment writes none. Until a source reports each send and
   it is recorded as an outbound unsolicited touch, a person enrolled in a
   sequence and also written to by this path can receive more than the cap.
3. **The opt-out is global, and closes even an invoice (0041).** Unchanged.
   This path sends what `acquisition` sends, which the global opt-out is right
   to refuse; what it costs a domain that invoices, 0041 already says.

## Limits this path has, noticed while deciding it

4. **Protection judges a list member by the company `relations` recorded,
   not by the one the target list gives now** — 0041's guarantee, which holds
   for enrolment because enrolment reads the target list. A list holds
   people, not the target list's answer about them. A person who moved to a
   customer, with neither their recorded company nor their address changed,
   is not seen. Asking the target list per member is a change to protection,
   outside this decision.
5. **A failed draft says nothing about why.** `draft` has no column for it;
   the reason is in the run's report and in its error. A column is a
   migration.
6. **A send the provider later reports under its own id is counted twice** —
   once as the message's touch, once as the pulled one. Too strict, never too
   loose; the real hand-over decides how a provider's id meets the message's
   key.

## Rules out

- A send whose consent or protection was read when its list was made.
- A message handed over before it is written, or a touch recorded before the
  hand-over.
- A cap that counts only what passed through the gate.
- A hand-over, a provider call or a command shipped by this decision.

## Would reverse it

A provider that cannot take a send before reporting it (0038, *Would reverse
it*). A real hand-over that must tell the kernel its own id before the touch
is recorded: then the link from a touch to its message is a column, not the
key, and that is a migration.
