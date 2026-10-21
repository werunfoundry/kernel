# 0017 — What comes back is pulled

> Completed by [0039](0039-events-are-pulled-and-kept-decisions-are-a-persons.md):
> the loop, its cursor and the event's write path.
>
> Completed by [0046](0046-the-addressing-domain-is-acquisition.md): the domain
> called `gtm` here is `acquisition`; read `gtm.x` as `acquisition.x`.

> Completed by [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
> an unsubscribe a sequencer can only observe as a state comes back by a
> second path; `Inbound` is unchanged.

## Decided

`gtm` gains an `Inbound` contract for the events it already declares —
`gtm.reply`, `gtm.bounce`, `gtm.unsubscribe`, `gtm.meeting_booked`,
`gtm.signup`. An adapter lists the ones it can produce.

**Pull, with a cursor.** `events({ after })` returns the events that happened
after the cursor, and always the next cursor, even with an empty page. A read
that could not reach the provider is an error, never an empty page.

**At least once, stored once.** An event carries the provider's own id. With
the adapter's provider name, that is the key `core.event` is already unique
on, so an event read twice is stored once.

**Tied to an identity and to a run.** Every event names its subject as an
identity (0013). An event the engine caused carries back what the engine sent
out with the enrolment — the run, the sequence, the channel, the experiment
and variant. `checkInboundEvent` refuses, all at once:

- an undeclared type;
- an invalid subject;
- a time that is not one;
- an empty event id;
- a run reference that cannot be a run.

## Why pull

**The kernel has nowhere to receive a push.** It runs as commands (0010),
with no server and no session (doctrine 5). A webhook needs a public endpoint,
its authentication, and a process that is up when the provider calls. Each is
infrastructure the instance would have to run for one contract.

**A missed push is silent.** A webhook delivered while nothing was listening
is gone, and nothing says so. A cursor not yet read is still there, and the
next read returns it. For a contract that carries opt-outs, "silently gone"
means contacting someone who asked to stop.

**Push is not ruled out, only placed.** A provider that only pushes is adapted
by something that receives and queues, and the adapter reads the queue with a
cursor. The contract stays one shape.

## What it deliberately does not do

- **No message bodies.** A reply's text stays in the mailbox it arrived in
  and is read there (doctrine 3). The event says it happened, to whom, on
  which run.
- **No acknowledgement.** Reading never deletes, marks or archives anything
  at the provider.
- **No interpretation.** Whether a reply is interested is not decided here.
  A provider's own label may travel in `detail`, and nothing branches on it.

## Not built here

The loop that reads events and writes them to `core.event` needs somewhere to
keep each adapter's cursor. No table holds it yet, and adding one is a change
to the core's objects that deserves its own decision. This one fixes the
contract and the check an event passes.

## Rules out

- A webhook endpoint in the kernel.
- An empty page standing for a failed read.
- Copying a reply's body.

## Would reverse it

A provider whose events cannot be read back after the fact — push or nothing —
for something that matters. It would be adapted with a queue first. If the
queue itself could not be built, this would be reopened.
