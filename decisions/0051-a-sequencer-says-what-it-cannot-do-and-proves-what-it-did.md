# 0051 — A sequencer says what it cannot do, and proves what it did

> Completed by [0054](0054-a-declared-capacity-has-a-method-behind-it.md): a
> verb is declared served only where the contract has a method for it, and
> the declaration is checked against the adapter.

> Completed by [0056](0056-erasure-stops-the-person-before-it-forgets-them.md):
> erasure suspends every enrolment a provider may still hold, before it
> anonymises the row.

> Completed by [0057](0057-a-newly-protected-account-is-stopped-when-a-run-looks.md):
> a newly protected account's recorded enrolments are suspended.

> Superseded in part by [0060](0060-a-pending-enrolment-is-stopped-as-it-stands.md):
> `suspended` is reached from `enrolled`, or from `pending` under a
> person's attestation; a read-back confirms a pending row, a person's word
> never does.

> Not built, on `main` at `350656e`: verbs 2 and 4, the two pulls: the
> contract has no method for either (0054), so no breach is ever
> established. Nothing calls a suspension. The shipped sequencer adapter's
> `enrol` answers from its write, not from a read-back.

> Built by #106, in part: a suspension is now called, by erasure (0056) and
> by the opt-out, read back and recorded. The two pulls are still not
> built.

Completes:

- [0014](0014-one-sequencer-contract-every-channel.md): the contract gains
  the pulls and a declaration of what an adapter lacks;
- [0017](0017-inbound-is-pulled.md): an unsubscribe can come back as an
  observation as well as an event, by a second path, and `Inbound` is
  unchanged;
- [0026](0026-the-enrolment-registry.md): the registry gains a state,
  `suspended`;
- [0039](0039-events-are-pulled-and-kept-decisions-are-a-persons.md): the
  opt-out gains a second writer, which applies it as the inbound pull does
  and never writes an event;
- [0049](0049-erasure-reaches-a-person-by-keys-and-says-what-it-does-not.md):
  erasure still does not reach the sequencer; it has said so since #89; this
  decision gives it the verb that will reach it, suspension;
- [0050](0050-the-sending-path-end-to-end-with-its-hand-over-stubbed.md):
  its second defect — the sends a sequencer makes on its own are recorded
  nowhere — gets a verb.

## What was found

A live test against the email sequencer this repository ships an adapter
for. It used throwaway sequences and six throwaway addresses, and judged a
stop by one criterion only: whether the next step went out. The calls are in
that adapter's README. What they showed:

- **Ten writes that should have paused one person all answered success and
  changed nothing.** The provider's own schema declares that request body closed to
  unknown fields (`additionalProperties: false`), and the next step went out
  anyway. A success code was not evidence of anything.
- **Four other ways did stop one person, and each one cost something.**
  One wrote a fact about the person — *not interested* — that was in truth
  our decision. One left the provider's status reading *active*, and changed
  the state of the sequence everyone else was in. One erased the
  provider's link between the person and the sequence they were in. One
  erased the provider's record of the person altogether.
- **What was sent can be read back, by time and by person, after the fact.**
  That record outlives both the person's record and the sequence's at the
  provider.
- **An unsubscribe is visible as a state, not as an event.** It has no time of
  its own and no filter by date. The only clock that moves is a generic
  modification time, which every other change to the record moves too. The
  provider's push notification for it exists and was not tested.
- **Records changed between two reads with nothing to say why.** People
  deleted by the provider, an hour after their sequences were, with no entry in
  the provider's audit log.

And, in this repository: **nothing calls a suspension.** Erasure deletes the
enrolment registry's row — the only record of where the person is enrolled —
and leaves them in the provider's running sequence. Its list of what it does
not reach has said so since #89. The opt-out sets a column and stops
there. Nothing withdraws the people at a company that becomes protected.

## Decided

**The sequencer contract declares four verbs the kernel needs**, beside
`suppress`, `status` and `capacity`, which are unchanged:

1. **enrol** — as 0014 has it;
2. **pull the touches since a point** — what the sequencer sent, step by
   step, with its own id for each, after a cursor (0017's shape: the cursor
   is opaque, and an adapter that can only filter by time keeps a time in
   it);
3. **suspend one person in one sequence** — the act 0011 named `withdraw`:
   no further step of that sequence reaches them;
4. **pull the unsubscribes since a point.**

**The touches pull is indexed on the person, never on the sequence.** Two of
the permitted ways of suspending break the provider's link between a person
and a sequence. A proof read by sequence would then find nothing for the
suspended person, and pass simply because the link is gone, whatever was sent.
The pull returns every send to the person's keys, and the kernel matches them to the enrolment.

**Verb 4 and `Inbound` are two paths, with one effect.** `Inbound` (0017)
carries unsubscribes a source reports as *events*, with an id and a time of
their own, and is unchanged. Verb 4 carries unsubscribes a sequencer can only
*observe* as a state. An adapter whose provider issues events serves them
through `Inbound`, and may also serve verb 4. Both end at the same write: the
person's opt-out, set if not already set (0039). That write is idempotent, so
a person seen on both paths is opted out once.

**Each adapter declares what it cannot do and what its suspension costs**,
statically, as it declares its channels and preconditions. For each verb it
either serves the verb, serves it partially and says why, or cannot serve it.
For suspension it names its costs, from a vocabulary the kernel reads:

- *about the person*: the provider's status keeps reading active; the link
  to the original sequence is lost at the provider; the provider's record is
  lost; the act cannot be undone;
- *about the sequence*: the shared sequence's own state changes, for everyone
  else in it.

**A declared incapacity is a fact of the system, not a failure.** It is
reported as such, the way an unprobed adapter is reported as unprobed (0009)
and an inapplicable metric as inapplicable (0021) — never as an error, and
never smoothed into a success.

**Among the ways of suspending that assert nothing about the person, the
adapter takes the least destructive one its provider offers.** In order: one
that keeps the provider's record and its link to the sequence; then one that
loses the link; then one that loses the record. When it takes a more
destructive one than its provider offers, it declares which, and why.

**The kernel refuses to enrol through an adapter that cannot suspend.** The
refusal is made from the declaration, before any call. An enrolment nobody
can stop until its sequence ends is protection that lasts only until the next
step fires (0004). Suppressing the person everywhere is not a substitute: it is a different act,
and stops everything to stop one thing.

**Three callers need suspension, and none exists yet:**

- **erasure** (0049) suspends every enrolment of the person *before* it
  deletes the registry's rows, because those rows are the only way to find
  them at the provider. Until it does, erasure names the sequencer among what
  it does not reach;
- **an opt-out**, from either path, suspends every enrolment of the person;
- **protection that becomes true mid-sequence** (0004) suspends every
  enrolment the registry holds at that company, beside the `suppress` that
  0011 gives it.

**An adapter proves its effects instead of inferring them. A return code
establishes nothing.** After a write, the adapter reads back from the
provider, and reports only what that read shows. A write whose effect cannot
be read back is reported as unconfirmed, never as done.

**The proof that a suspension held arrives later, and the window it needs is
not known.** A step the provider had already picked to send when the
suspension took effect can still leave. How long that window lasts was not
measured. The only evidence is that steps left six to seven minutes after
they were due, and that suspensions made eighteen minutes or more before a due step all held. So:

- each adapter declares a delay after the suspension's read-back, within
  which a touch to the person is *in the gap*, not a breach. The delay also
  covers the drift between the provider's clock, which times the send, and
  the kernel's, which times the read-back. **The declared delay carries its
  basis and its date** — the measurement it comes from and when it was made
  — as every claim in an adapter's README does;
- **a breach is established only for a touch sent after that delay**, and
  the kernel reports it;
- an adapter that has not measured its delay declares it unknown. Then
  every touch after a suspension is reported as *after suspension, gap
  unknown*: neither a breach nor accepted, for a person to judge.

**The kernel records the suspension itself, in the enrolment registry.** The
state is **`suspended`**. It is reached from `enrolled`, and it is
**terminal**: a suspended enrolment does not become `enrolled` again.
Resuming it would mean contacting again someone we decided to stop. That is a
new enrolment, decided anew, not a step back in an old one. The registry
holds one row per person and sequence, so that person is not enrolled in
that sequence again. The row records when the
suspension was asked, by which run, the adapter's read-back, and the method's
declared costs. The provider's status is not the record: it may keep reading
active, and whatever reference the provider keeps for the suspension
disappears with the object it points to. That reference is a cross-check,
read as such.

**An adapter never passes off as a fact something the provider did not
say.**

- It never suspends someone by writing a fact about them that was ours to
  decide: an interest status, a label, a reply category. A way of stopping
  that lies about the person is not on the list of ways, however clean it is
  otherwise.
- It never reads a shared modification time as the time of one particular
  change.
- **The kernel records an observation stamped with its own time, not an event
  it did not see.** An unsubscribe found by reading a state is recorded as
  observed at the read that found it: it happened after the last read that
  did not show it, and no later than this one. It is not written as an
  event with an occurrence time and a provider event id that nobody issued
  (0039). The opt-out is still applied as soon as it is observed: an opt-out
  observed and not applied would mean contacting someone who asked to stop.

**What a provider holds is true only as of the read.** A provider's state
does not hold still between two reads, and its audit log may say nothing about why it moved. An adapter
guarantees only what it has just read. Every answer carries the time of that
read, and no answer is carried over to a later one. A record that was there
and is now gone is a change at the provider, not an act of the kernel.

## What the commands say they do not reach

- **`kernel-enrol`**, before it enrols anyone, prints the bound adapter's
  declared incapacities, its suspension's costs and its gap delay, or that the
  delay is unknown. If the adapter cannot suspend, it stops there.
- **A suspension** says that it does not reach a step already picked to send
  within the declared gap, or that the gap is unknown.
- **The unsubscribes pull** says, for an adapter that can only list the
  current state, that it is a full read of every unsubscribed person, filtered
  on the kernel's side. Nothing unsubscribed since the point is missed, but
  some returned are older, and its cost grows with the provider's total, not
  with what changed. That adapter declares the verb partial. Its times are
  read times, never times of the unsubscribe itself.
- **Erasure**, until it calls suspension, names the sequencer among what it
  does not reach.
- **Neither pull reaches** what the provider deletes before it is read, or
  what its audit log does not record.

## Rules out

- A write reported as done on its return code alone.
- A suspension that writes a fact about the person.
- Deleting the person at the provider to suspend them, unless no less
  destructive way exists there and the adapter's declaration says so.
- A proof of suspension read by sequence.
- A breach declared within the gap, or a touch in an unknown gap reported as
  either a breach or as accepted.
- A suspended enrolment returning to `enrolled`.
- A provider's shared timestamp recorded as the time of a particular event;
  an observation recorded as an event.
- An enrolment through an adapter that cannot suspend.
- A guarantee about a provider's state older than the read it rests on.
- A declared incapacity reported as an error, or hidden behind a success.

## Would reverse it

A provider whose writes come back with the resulting state, and whose
unsubscribes are events with an id and a time of their own. Then reading
back a write duplicates the proof, and verb 4 is not needed for that
adapter: its unsubscribes come through `Inbound`. What would reverse this
decision for every adapter is a read-back that costs more than the write it
proves — at a provider's rate limit, at scale. Proof would then rest on the
touches pull alone, and every suspension would stay unconfirmed until the gap
had passed.

`suspended` is terminal because it records a decision to stop. A
provider's ability to resume does not reopen that. A need for a hold the
kernel means to lift — a pause, not a stop — would be a different state,
decided on its own, and not a way back out of `suspended`.

## Not decided here

- **The shape of the declaration, and the registry's columns** beside the
  state. Their types and migration are the implementation's; the value
  `suspended` is fixed here, because a Postgres enum value cannot be removed.
- **Where an observation lives.** Under its run (doctrine 5), not in
  `core.event`. Whether it needs a row of its own is the implementation's
  question, answered before the code is written.
- **The gap delay of the adapter this repository ships.** It is measured by
  a live test that suspends at known offsets before a due step, or it stays
  declared unknown.
- **The push notification for an unsubscribe**, which was not tested. Nor
  was `suppress` against a live workspace: the test key lacked that scope.
- **How a pulled touch finds the message it confirms** (0050, *Limits*).
