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

**A refusal would protect against nothing observed.**
- *Nothing was rewritten.* With tracking on, the one body measured
  arrived with its URL and its bare domain as written.
- *No link of the kernel's crosses the provider.* The way out is the
  provider's own link (0065 §2), and the kernel serves none. A rewritten
  provider link still lands at the provider; tracking cannot take the way
  out away from anyone.
- *What a rewrite would cost, if one is seen.* The kernel's record of a
  message with links would hold the URL it wrote, where the person
  received another: a cost to what the record says, not to whether the
  person can stop us. That is 0065's cost, and it stays a declared unknown
  for an HTML body, which was not measured.

**Not a check either.** The read gives a reliable positive and no reliable
negative:
- *On:* `link_tracking: true` is on.
- *Absent:* the field may be missing because tracking is off, because the
  read did not return it, or because the campaign is older than the field.
  An absence has been seen once, on one day.

So the read cannot serve as a safety check: whatever rested on it would be
answered by an absence nobody can interpret. That is a caution about the
read, not the reason there is no refusal; the reason is the measure above.

## Rules out

- A refusal of link tracking for a harm nobody observed.
- The read used as a safety check, and an absent `link_tracking` read as
  off.
- The setting known by the provider's record of a send (0065 stands).

## Would reverse it

- **A rewrite seen in a delivered message** that harms the way out: a
  provider link turned into one that no longer lands at the provider. A
  refusal would then protect someone, and the read's positive could carry
  it. A rewrite that only changes what the record says brings back 0065's
  cost, not a refusal.

## Not decided here

- Whether a read that returns the field in both states, documented and
  seen off as well as on, would make the read a check.

- Whether the positive is used: shown at enrolment, recorded on it.
- What tracking does to an HTML body.
