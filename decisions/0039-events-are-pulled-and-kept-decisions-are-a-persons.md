# 0039 — Events are pulled and kept; a decision is a person's

> Completed by [0046](0046-the-addressing-domain-is-acquisition.md): the domain
> called `gtm` here is `acquisition`; read `gtm.x` as `acquisition.x`.
>
> Completed by [0047](0047-a-persons-acts-are-commands-at-a-terminal.md): a
> person records a decision with `kernel-decide`.

> Completed by [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
> the opt-out gains a second writer, which applies it as the inbound pull
> does and never writes an event.

Completes [0017](0017-inbound-is-pulled.md), which fixed the contract and
left the loop and its cursor to a decision of their own.

## Decided

**`core.event` is append-only.** An event is what was observed: its type,
the source it came from and that source's id for it, when it happened there,
when it was read, the run that read it, and its payload. A trigger refuses
any update. `processed_at` goes: nothing wrote or read it, and whether an
event was handled is a run that names it (`run.event_id`), not a column
that changes. `occurred_at` comes in: a measurement window is about when
something happened, not when it was read.

**Typed by what the domains declare.** An event is written only through
`recordEvent`, which refuses a type no enabled domain declares — the check
`checkInboundEvent` already made (0017), now on the write path.

**One writer per source.** A source is an inbound binding. Its cursor is a
row in the domain whose contract it is read through — `gtm.inbound_cursor`
for `Inbound` — and the pull holds that row locked for the whole read: two
pulls of one source wait for each other, never interleave. The cursor
advances in the same transaction as the page it covers, so a crash replays a
page — stored once, by the unique key — and never skips one. Not in the
core: a cursor is the bookkeeping of one way of reading, and the core records
work, not how a domain reads its sources.

**The pull** — `kernel-inbound`, in the addressing domain — reads each
inbound binding after its cursor, as its own run, and writes:

- **the event**, always, once;
- **an inbound touch**, when the event names a person already recorded and a
  channel a domain declares: the person-level trace the reactive lane needs
  (0027). A person the engine never recorded is not created from an event;
- **the opt-out**, for `gtm.unsubscribe`, on the person, if not already set.
  An opt-out read and not applied would be a contact with someone who asked
  to stop.

A dry run reads and reports, and writes nothing — not the cursor either.

**`core.decision` is one line, written by a person.** On this date, this
person concluded this, on this experiment, having read these figures. It
names its experiment (restrict: an experiment with a decision on it is not
quietly deleted), its conclusion, optionally why, and the readings it rested
on, frozen as they were read (doctrine 3). A person's act, in its own run;
the schema refuses any other actor and any update. Nothing computes a
decision.

## What this narrows

The existing `core.decision` was polymorphic — "a decision can be about
anything". It is now about an experiment, which is what the core's record of
work says a decision concludes (0035). A decision about something else
would come back with its own case. Nothing wrote the table; the migration
refuses to run where something did, as it does for `core.event`.

## Not done here

- **The reactive lane still fails closed.** Its trace now exists — an inbound
  touch, by person and channel — but the gate that reads it is a change to
  0027's lane and gets its own pull request.
- **No metric source reads `core.event`.** The metrics read their sources
  (0018); a source over the event record is an adapter, not this.
- **No process is triggered by an event.** What a process is is not decided
  (README, *Processes*).
- **No schedule.** `kernel-inbound` is a command; when it runs is the
  instance's business.

## Rules out

- An event rewritten, or marked handled in place.
- An event of a type no domain declares.
- Two writers on one source at once; a cursor ahead of what was stored.
- A person invented from an event.
- A decision computed, or written by anyone but a person; a decision edited.

## Would reverse it

A source that cannot be read back after the fact (0017's own reversal), or
decisions that turn out to need a subject other than an experiment often
enough to want the polymorphism back — then it returns, written down, with
the case that needed it.
