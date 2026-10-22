# 0066 — Link tracking is read when it is on, and is still not a refusal

Supersedes in part [0065](0065-the-kernel-writes-what-is-delivered-and-every-message-says-how-to-stop.md),
its section 4: two of its statements, and the reason it gives for not
refusing a sequence whose link tracking is on. The decision itself stands:
link tracking is a declared unknown, not a refusal.

## What was found

The shipped sequencer adapter's README, section *The throwaway campaign of
2026-10-22*: one campaign created with link tracking on, one lead, one
send to one address of the operator's.

- **The setting is read back when it is on** (the provider's record): the
  campaign's read returned `link_tracking: true`. On 2026-10-21, with it
  off, the read returned no `link_tracking` at all. 0065's bullet *Reading
  it* is true of that day; the conclusion above it, "all closed", is not.
- **Nothing was rewritten** (the message received): the body arrived as
  `text/plain`, and the URL and the bare domain arrived as written. 0065
  said "With tracking on, the provider rewrites the URLs in a body"
  without having measured it.

## Decided

### 1. Two statements of 0065 §4 are withdrawn

- *"Three ways of knowing the setting, all closed."* Reading it is open,
  for one answer: on.
- *"With tracking on, the provider rewrites the URLs in a body."* On a
  plain-text body it rewrote nothing. On an HTML body it is not known: the
  provider delivered none.

### 2. Still no refusal, for another reason than 0065's

**The read gives a reliable positive and no reliable negative.**
- *On:* `link_tracking: true` is on.
- *Absent:* the field may be missing because tracking is off, because the
  read did not return it, or because the campaign is older than the field.
  An absence has been seen once, on one day; it is not a negative.

**Under 0051's rule an absence would read as on.** Nothing said is read
as the answer that assumes the least, and here that is "on". A refusal
resting on the read would then refuse every campaign that does not return
the field: everything, for an unknown. That is what 0065
§4 already declined to do to the only adapter there is.

So the refusal is not ruled out because the setting cannot be read. It is
ruled out because its absence cannot be read. Whoever finds the setting
readable must not take that as the reason to bring the refusal back.

## Rules out

- A refusal of link tracking resting on the read.
- An absent `link_tracking` read as off.
- The setting known by the provider's record of a send (0065 stands).

## Would reverse it

- **A read that returns the field in both states**, documented and seen
  off as well as on. Off would then be a negative, and a refusal could
  rest on it.
- **A rewrite seen in a delivered message.** 0065's cost would be back:
  the kernel's record of a message with links would hold the URL it wrote,
  where the person received another.

## Not decided here

- Whether the positive is used: shown at enrolment, recorded on it.
- What tracking does to an HTML body.
