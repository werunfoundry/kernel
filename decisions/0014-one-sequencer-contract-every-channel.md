# 0014 — One sequencer contract, every channel

> Superseded in part by [0020](0020-capacity-carries-every-limit.md): capacity carries every limit, and the tightest applies.

> Completed by [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
> the contract gains the two pulls, and a declaration of what an adapter
> cannot do and what its suspension costs.

> Superseded in part by [0064](0064-one-verb-reaches-a-person-and-carries-the-message.md):
> `enrol` names a sequence, and the sequence's steps name its channels.

Supersedes in part [0011](0011-the-sequencer-after-a-real-provider.md): what
`suppress` takes, and what `capacity` is.

## Decided

`Sequencer` serves every channel the enabled domains declare — `email`,
`social_message`, `social_invite`, `social_comment`, `profile_visit` — and an
adapter says which it serves, in `channels`.

- **`enrol` names a channel**, and takes an identity (0013), not an address.
  An adapter asked for a channel it does not serve, or handed an identity
  without the key its channel reaches people by, refuses as `invalid`.
- **Capacity is per (sender, channel)**, in that channel's own unit and
  window: `{ unit, window: "day" | "week", limit, used, remaining }`. Two
  channels' numbers are never added together.
- **Preconditions are declared by the adapter**, per channel —
  `preconditions: { social_message: ["connection_accepted"] }` — and an
  enrolment that waits on one reports `awaiting_precondition`, with the
  unmet names in `pending`. The engine can plan with them before enrolling
  anyone, and can tell "waiting" from "failed".
- **`suppress` takes an identity**, applies every key of it the adapter can
  act on, across every channel it serves, and returns `{ applied,
  notApplicable }`. An identity with no applicable key is refused as
  `invalid`. A suppression that applied nothing has protected nothing, and an
  `ok` would have said otherwise.

The email adapter is ported: channel `email`, the `email` key for people,
`email` and `domain` keys for suppression. Its network behaviour does not
change; the pinned endpoint list did not move.

## Why one contract and not a second, social one

**Suppression has to be one act.** Protection is "this person, this account,
nowhere". With a `SocialSequencer` beside `Sequencer`, suppressing would be
two calls on two contracts, and the second one is the one someone forgets.
The hole is not hypothetical: it is the shape of every "we unsubscribed them
from email" that still sent the invitation.

**Providers do not split along the line.** Some tools send email only, some
work a social network only, some run one sequence that does both. Two
contracts would make the third kind implement both and coordinate itself, or
be forced into one of the two.

**What differs between channels is data, not shape.** Units, windows and
preconditions differ; enrolling, withdrawing, suppressing and reading a
status do not. Data goes into the types — `unit`, `window`, `preconditions` —
and the operations stay one set.

## What 0011 said and why it changes now

0011 kept `capacity` per sender, as an account's daily limit, and wanted a
second sequencer before changing it. No second real sequencer exists yet. What
forces the change is a fact about channels rather than about one provider: an
invitation channel counts invitations over a week, an email channel counts
messages over a day, and a per-sender number cannot hold both. The per-
campaign caps that 0011 recorded as missing remain missing.

0011's `suppress` took an address or a domain. An identity holds both, and the
keys of every other channel.

## Rules out

- A second sequencer contract for a channel.
- Capacity summed across channels.
- A suppression that reports success having applied nothing.
- An adapter enrolling on a channel it did not declare.

## Would reverse it

A channel whose operations differ in kind and not in data — one where
"enrol", "withdraw" or "suppress" do not mean anything. None of the five
declared channels is such a channel.
