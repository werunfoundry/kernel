# 0027 — A draft waits on its lane

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
- `reactive` — nothing written defines it, so it requires what `reviewed`
  requires. A lane nobody defined does not open the gate.

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

- **What `reactive` allows.** Until someone says, it is `reviewed`.
- **Whether a lane-approved draft is re-gated at queue time** when the streak
  has dropped since. Today the approval stands, as a human's would.
- **Sending.** `queued` hands a draft over; `sent` and `failed` are written
  by the sending path, which does not exist yet.

## Would reverse it

A lane whose review happens outside the engine — a tool where reviewers work
and from which only verdicts arrive. Then the draft would mirror a decision
taken elsewhere, and the gate would read it rather than hold it.
