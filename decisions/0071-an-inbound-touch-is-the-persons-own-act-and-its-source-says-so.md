# 0071 — An inbound touch is the person's own act, and its source says so

Supersedes in part [0039](0039-events-are-pulled-and-kept-decisions-are-a-persons.md),
whose pull writes an inbound touch "when the event names a person already
recorded and a channel a domain declares", and
[0042](0042-a-reactive-reply-is-licensed-by-the-persons-inbound-touch.md),
which reads that touch as "the person's own act". Completes
[0065](0065-the-kernel-writes-what-is-delivered-and-every-message-says-how-to-stop.md),
which left the inbound source for a sequencer's mailbox to a later decision.

## What was found

- **Any event with a channel writes a touch.** On `main` at `a80282a`,
  `runtime/inbound.ts`, `pullInbound`, writes an inbound touch for every
  event that names a recorded person and a declared channel, whatever its
  type; its test expects one for an unsubscribe.
- **That touch is the reactive lane's license** (0042). `engagedSince`
  counts any inbound touch on the channel inside the window.
- **A sequencer's mailbox holds what a person did not do.** The shipped
  sequencer's provider marks an automatic reply (`is_auto_reply`, in its
  published API document). On 2026-10-22 it recorded a reply written from
  another address in the thread as the lead's reply (adapter README). A
  bounce comes back on the same channel. Read as 0039 has it, each would
  license a reactive reply.
- **No source writes such a touch yet.** The sandbox's events and the CRM's
  meetings carry no channel (0042, *What this does not do*).

## Decided

**A touch is written only for an act of the person's toward us**: a reply,
a meeting booked, a signup, and only when the source says the person named
did it. Never for a bounce, which is the mail system's, nor for an
unsubscribe: it is the person's, but it asks for no contact, and a license
to answer it would say the opposite. Both are still stored, and the
unsubscribe still records the opt-out.

**The source says it; the kernel does not guess.** An inbound event carries
`byThePerson`, the source's word that the person in its subject did it
themselves. Absent, the event is stored and tied to the person, and writes
no touch. A source that cannot tell stays silent, and the lane stays shut on
what it reads: the default that assumes the least, as in 0065.

**The sequencer's mailbox says it from two facts of its own record**: the
reply is marked not automatic — marked, not merely unmarked — and it was
written from the lead's own address. A reply from someone else in the
thread, or one whose author cannot be read, is stored as the lead's reply,
the provider's attribution, and is not their act.

**`replied` is counted from the events, never from the touches.** The two
want opposite errors. The lane wants to be strict: a touch wrongly written
is a contact nobody asked for. A count of replies wants to be complete: a
reply missed makes outbound read worse than it is. Every reply is stored
as an event, whoever wrote it, with the source's `byThePerson` in its
payload; a touch is written for some of them only. A metric that counts
touches undercounts by exactly what this decision leaves out. A metric of
replies reads `acquisition.reply` events, and says whether it counts the
replies its source does not say the person wrote.

**This reads who, never what.** 0017 keeps the reply's words out of the
kernel and its meaning undecided. Neither moves: no body is read, and
whether a reply is interested, or asks to stop, is still a person's
reading (0065 §3).

## Rules out

- A reactive reply licensed by a bounce, an automatic reply, an unsubscribe,
  or a message from someone else in the thread.
- A touch written on the kernel's guess, from an event's type alone or from
  its words.

## What this does not reach

- **A person who answers from another address**: a phone, an assistant, a
  forward. The reply is stored as the lead's, its author is not the lead's
  address, and the lane stays shut on it. That is the side this decision
  chooses to fail on: a person then approves the reply, as on `reviewed`.

## Would reverse it

- **An automatic-reply mark found wrong in practice.** A person's replies
  marked automatic would shut the lane on them; a mark that misses would
  open it to a machine. Neither has been read yet (below).
- **A lane that answers the mail system**, a bounce resent elsewhere. It
  would need a license of its own, not this one.

## Not observed

The reply's author and its mark are read from fields of the provider's
published document, never yet seen on a live reply. Until one is read, a
field that reads otherwise writes no touch: the lane stays shut, it does not
open. The first run does not settle it: its leads are aliases of the
operator's, and the operator's replies leave from the primary address, as
on 2026-10-22. They can show the author field's shape and that a reply
from another address fails closed, never that a reply from the lead's own
address opens the lane.
