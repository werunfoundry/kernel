# 0057 — A newly protected account is stopped when a run looks

> Completed by [0060](0060-a-pending-enrolment-is-stopped-as-it-stands.md):
> the act reaches pending rows too, asked of the provider first.

> Not built, on `main` at `350656e`: none of it — neither the act, its hook
> at enrolment, nor its command. Nothing withdraws a newly protected account
> from a running sequence.

> Built by #113: the act, at the start of every enrolment run and as
> `kernel-stop-protected`, which the instance schedules. Enrolled rows are
> suspended and recorded, pending rows asked first and confirmed by their key
> (0060), and each account suppressed through the sequencer bound to its
> rows. A live act that met no refusal writes `acquisition.protection_held`.
> Not reached: a company protected only by the target list's own identifier,
> which the registry does not record.

Completes [0004](0004-protection-is-its-own-route.md), whose promise that
a newly protected account is withdrawn from running sequences nothing
keeps; and [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
whose suspension nothing calls. Supersedes in part
[0011](0011-the-sequencer-after-a-real-provider.md), whose ground 0051
moved: protection after enrolment depends on `withdraw` *and* `suppress`,
not on `suppress` alone.

## What was found

On `main` at `170f4a2`.

- **0004's promise is kept by nothing.** Protection is read at the start of
  three runs: enrolment (`domains/acquisition/runtime/enrol.ts:335`),
  sourcing (`source.ts:350`) and sending (`send.ts:245`). Each run reads it
  to exclude whom it is about to reach. None of them looks at the
  enrolments already running.
- **Nothing says when an account became protected.** The protected set is a
  state, read from a source with a freshness (0041). It is not a stream of
  events.
- **0011 put protection after enrolment on `suppress`**, and ruled out a
  series of per-person withdrawals. Its reason was that only `suppress`
  reaches a colleague the kernel never enrolled. The contract says the same
  (`contracts/sequencer.ts:420`).
- **0012 says a provider's blocklist is defence in depth, not
  protection.** One request can empty it, and what removing an entry does
  is not documented.
- **The shipped adapter's `suppress` reads before it writes, and not
  after** (`adapters/…/index.ts:458-466`). 0051 asks every write to be
  read back.

## Decided

**One act stops a protected account's running sequences.** It reads
protection as enrolment does: fresh, failing closed, with the same verdict
(0044). Then, for each account it protects at which the registry holds an
`enrolled` row, it does two things:

1. **It suspends each of those rows** through the sequencer bound to its
   channel, read back and recorded as 0051 has it. **This keeps 0004's
   promise.** That promise is about running sequences, so about the people
   the kernel enrolled: the kernel can say whom it stopped, when, by which
   run, and how.
2. **It suppresses the account at the provider**: by the account's keys,
   and by the address of each person enrolled through it that those keys do
   not cover. **This goes beyond the promise**, to the colleague the kernel
   never enrolled, who is in no sequence the kernel started. Following
   0012, it is defence in depth, not the record.
   [0056](0056-erasure-stops-the-person-before-it-forgets-them.md) refuses
   the same write for an erased person: there, the address would keep a
   datum about someone the kernel has forgotten; here, it stops a contact
   with someone still on record.

**Why this supersedes 0011 in part, and not on a judgment.** 0011 put
protection after enrolment on `suppress` before 0051 existed. 0051 requires
an effect to be proved by a read-back and recorded. A `suppress` that is not
read back, and writes nothing in the registry, cannot satisfy it. This
decision only records that the ground moved.

0011 ruled out protection built from per-person withdrawals *alone*. That
stands.

**Two occasions run the act.**
- **The start of every enrolment run**, before anyone is enrolled. It uses
  the protection that run has just read, so protection is not read twice.
- **A command of its own**, which the instance schedules.

**0004's promise is kept only as often as one of the two runs.** Between
two runs, an account that became protected keeps receiving every step its
sequences send.

The hook at enrolment is not that promise kept. It runs when someone
enrols, so an instance that stops enrolling stops withdrawing. The command
is how an instance keeps the promise, at the rate it chooses. The kernel
does not choose that rate, and does not claim it.

What the kernel can say instead: each run of the act records the protection
it read and how old it was. The last such run is how far the promise is
known to hold, and nothing claims more.

**It fails closed.**
- *Protection unreadable or stale:* the act stops and changes nothing. In
  the hook, the enrolment run stops too, as it already does.
- *A suspension or a suppression fails:* the act ends failed. Its refusal
  names the adapter and what it answered, and says that running it again is
  the remedy.
- *In the hook:* the enrolment run then stops before enrolling anyone. A
  run that cannot stop the protected it already reached does not reach
  anyone new.

**A dry run says whom it would stop**, through which bindings, and writes
nothing.

**Does the command need a decision of its own? No.** A command adds no
object, no dependency and no package. What needs a decision is what it asks
of the instance: keeping 0004's promise now depends on a schedule the
instance owns. That is a change to what an instance owns, and this decision
is it.

## What it does not reach

- **The time between two runs**, as above.
- **The steps already scheduled in the gap** before a suspension takes
  effect (0051).
- **Which company protection judges** an enrolment by: the one its row
  names, and the person's addresses. That is left open, as 0055 left it.
- **Whoever was enrolled at the provider by hand, or by another
  instance.** Suppression may reach them; the registry does not know them.
- **An account that leaves the protected set.** It is not resumed: a
  suspension is terminal (0051). A suppression stays at the provider until
  a person removes it.

## Rules out

- The hook at enrolment presented as 0004's promise kept.
- A withdrawal from a protection read that is stale or unreadable.
- An enrolment run that enrols anyone while a protected account it found
  enrolled could not be stopped.
- A suppression treated as the record that a person was stopped.
- Resuming an enrolment when protection lifts.

## Would reverse it

**A protected source that emits an event, with its own time, when an
account enters it.** The act would then follow the event, not a schedule,
and the promise would hold to the event's latency.

**A sequencer whose suppression is read back and cannot be emptied
wholesale.** Suppression would then be enough, as 0011 had it.

## Not decided here

- **The command's name**, how an instance schedules it, and every shape.
- **Reading a suppression back.** 0051 requires it, and the shipped adapter
  does not do it. That is the adapter's to fix, before this act depends on
  it.
