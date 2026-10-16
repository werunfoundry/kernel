# 0042 — A reactive reply is licensed by the person's inbound touch

Completes [0027](0027-a-draft-waits-on-its-lane.md), whose `reactive` lane
failed closed until inbound could be verified, and
[0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md),
whose message gate refused `lane:reactive` for the same reason.

## Decided

**The license is an inbound touch.** Since 0039, a pulled event that names a
recorded person and a declared channel leaves an inbound `relations.touch`.
That is the person's own act, by person and channel, which 0027 said the
lane needs. A draft on a `reactive` experiment is approved by the lane —
`decided_by = lane:reactive` — when there is an inbound touch from that
person, on the draft's channel, inside a window before now. Without one, a
person approves, as on `reviewed`.

**The window is the caller's**, in minutes, with no default — like
`autonomyAfter`. A caller that gives none gets a human approval: no window,
no license.

**The draft's channel is its template's.** A draft has no channel of its
own; the template it renders does. A draft with no template has no channel
the license can be checked against, and a person approves it.

**Both gates read the same license.** The message gate (0038) accepts
`lane:reactive` on the same terms: the experiment's lane is `reactive` and
it is running, and an inbound touch from the person on the message's
channel lies inside the caller's window. Otherwise a draft the lane
approved could never be sent once a sending path exists, and the second
gate would be refusing a send the first had licensed. The two still add up:
the message gate checks the license again at the moment of writing.

**Everything else is as before.** An opted-out person is not drafted for
and not written to; a draft is queued only while its experiment runs. A
lane approval moves no streak (0027).

## What this does not do

- **It does not tie the reply to one event.** The window stands for "in
  reply to": any inbound touch from the person on that channel inside it
  licenses the reply. Which message the person answered is not checked.
- **It does not open the lane in practice yet.** A touch is written only for
  an event that names its channel. The one inbound source bound today
  reports meetings, with no channel, so it writes none; until a source
  reports replies on a channel, every reactive draft still waits on a person.

## Rules out

- A reactive approval with no window, or with a default one.
- A reactive approval for a draft with no channel.
- A message written under `lane:reactive` without the same license.

## Would reverse it

A reply that must answer a specific event — a support ticket, a question —
rather than any recent contact. Then the license names the event, and the
draft carries a reference to it.
