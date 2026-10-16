# 0027 — A draft waits on its lane

> Completed by [0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md):
> writing the message is a second gate, beside this one.
>
> Completed by [0042](0042-a-reactive-reply-is-licensed-by-the-persons-inbound-touch.md):
> the reactive lane is licensed by the person's inbound touch.

## Decided

A proposed message is a `gtm.draft` row before anyone sees it, and is sent
only once approved as its experiment's lane requires. `gtm/runtime/draft.ts`
is the gate: `propose`, `approve`, `drop`, `queue`. It does not write copy.

**What each lane requires.**

- `reviewed` — a human approval, always.
- `autonomous` — a human approval until the experiment has earned autonomy:
  `autonomyAfter` consecutive human approvals with no edit, a number the
  caller gives, with no default. Earned, a new draft is approved by the lane
  when it is proposed, and says so (`decided_by = lane:autonomous`).
- `reactive` — a send without human approval **only in reply to an inbound
  event from the same person**, within a window the caller gives with no
  default, on a channel where that person has already engaged. It is not an
  earned streak like `autonomous`: the person's own action licenses the
  reply. Suppression and protection apply as everywhere else, and an opt-out
  is never sent.

  **Today it fails closed and waits for a human, as `reviewed` does.** The
  engine cannot yet verify that such an event exists: inbound is not wired
  (0017), and nothing records an inbound event against a person. A reply the
  engine cannot tie to the person's own action is not licensed by it. When
  inbound lands, the check is: an inbound event from this person, on this
  channel, inside the caller's window — and without one, still a human.

**Only a human approves.** An approval attributed to an agent or the system
is refused: the lane's approval happens in `propose`, nowhere else.

**The streak.** A clean human approval adds one; an edit, or a human's drop,
sets it to zero. A drop by the system (an opt-out) and an approval by the
lane move it not at all. It is written only by `core/runtime/experiment.ts`
— the core's column, the core's writer — inside the reviewing transaction,
with the experiment locked so two reviews cannot read the same streak.

**The gate is in the schema too.** A trigger on `gtm.draft` allows only the
moves forward — drafting to review, approved or dropped; review to approved
or dropped; approved to queued or dropped; queued to sent or failed — refuses
a draft created past review, and freezes the rendered text once decided, so
what goes out is what was approved. Two checks make every decision carry who
took it and when, and every drop its reason.

**Whatever the lane**, nothing is drafted for a person who opted out, a person
who opts out after the approval is dropped at the gate by the system, and a
draft is queued only while its experiment is running.

**Regenerating** the same person, step and experiment gives an undecided
draft the new text and applies the lane again; a decided draft is kept as it
is.

## Why

The table, the lane and the streak existed, with comments describing all of
this, and nothing enforcing any of it: a draft could be marked queued by
anyone who could write a row, and the streak was a number nobody wrote. The
review loop had a source of truth only in its comments.

## Rules out

- Sending a draft that is not approved, by any writer.
- An agent approving its own work.
- A streak raised by decree, or by the lane's own approvals.
- Changing an approved text.
- A default threshold for autonomy.

## Not decided here

- **Whether a lane-approved draft is re-gated at queue time** when the streak
  has dropped since. Today the approval stands, as a human's would.
- **Sending.** `queued` hands a draft over; `sent` and `failed` are written
  by the sending path, which does not exist yet.

## Would reverse it

A lane whose review happens outside the engine — a tool where reviewers work
and from which only verdicts arrive. Then the draft would mirror a decision
taken elsewhere, and the gate would read it rather than hold it.
