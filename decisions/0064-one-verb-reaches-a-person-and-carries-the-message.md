# 0064 — One verb reaches a person, and it carries the message

Supersedes in part [0050](0050-the-sending-path-end-to-end-with-its-hand-over-stubbed.md):
its run 2 hands over to nothing, and its cap judges only the window behind.
Supersedes in part [0055](0055-one-passage-reaches-a-person.md): the whole
of its section 2, the hand-over among the contact verbs of its section 1,
and "for a send" in its section 5. Supersedes in part
[0014](0014-one-sequencer-contract-every-channel.md): `enrol` names a
sequence, and the sequence's steps name the channels. Completes
[0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
whose verb 2 has no method, with a refusal of the same form as its first.

## What was found

On `main` at `f927ab0`.

- **The hand-over has no object.**
  - *Where it is.* It is a runtime interface, `HandOver` in
    `domains/acquisition/runtime/send.ts`. It is not a contract: no binding
    names it, and no adapter implements it.
  - *Who calls it.* No command. Only the path's tests and `try-instance`
    (`draftFromList`, `sendFromList`), each with a stub of its own.
- **The contract already holds that a message is a sequence.** Its header
  in `contracts/sequencer.ts` says: "A single message is a one-step
  sequence. There is no `send` here, so that there is one path and one
  place where suppression is checked."
- **What a variable is for says the opposite of this decision.**
  `Enrolment.variables` reads: "The engine renders what it can itself;
  what remains here is what the provider must resolve at send time."
- **The kernel already holds what a step is.**
  - *A template* is one step of one variant of one sequence (`template` in
    `domains/acquisition/db/schema.ts`): `step`, `channel` and
    `delay_days`, under an experiment.
  - *A draft* is unique per experiment, person and step
    (`draft_experiment_person_step_uidx`).
  - *What is missing* is the provider's side. Nothing reads the steps the
    provider will run, so nothing compares them with the templates.
- **The cap already counts by person, on every channel.** `writeMessage`
  (`domains/relations/runtime/message.ts`) counts the person's outbound
  unsolicited touches in the window, whatever their channel. To these it
  adds the unsolicited messages that no touch names yet. A message is
  counted by the time it was written, never by when it will leave.
- **The opt-out is blind to the channel.** It is a column on the person
  (`opted_out_at`) and a register keyed on the keys (0052). Neither names a
  channel.
- **A person may be in two sequences.** The registry's uniqueness is
  person and sequence (`enrolment_person_sequence_uidx`), not person and
  channel. A row records one `channel`.
- **The touches pull is decided, declared, and has no method.**
  - *Decided.* 0051 named it verb 2: "what the sequencer sent, step by
    step, with its own id for each, after a cursor", indexed on the person.
  - *Declared.* `SequencerDeclaration.pullTouches` is "0051's verb 2. No
    method in this contract yet."
  - *In the shipped adapter.* It declares it not served. Its README records
    that the provider lists each send with the lead and the step.
- **No verb reads a sequence's steps.** A sequence is a key the adapter
  maps to a provider object through its binding's options. The manifest
  declares no sequence.
- **0055 section 2's three reasons describe the code; they are not why it
  must stay so.** Each one already names what fills it:
  - the touches pull, for a complete count;
  - the steps known to the kernel, for a cap judged ahead;
  - an enrolment that carries a message, for a lane.

  This decision builds the three.

## Decided

### 1. One verb reaches a person: `enrol`

**The hand-over is withdrawn.** `reach` (0055) calls one contact verb,
`enrol`. A single message is an enrolment in a one-step sequence, as the
contract already says.

0050's run 2 goes with the hand-over: its steps 6 to 8, the queue, the
hand-over and the touch it confirmed. What run 2 evaluated before the
hand-over moves to the enrolment: protection, consent, cadence and lane.

### 2. Drafting feeds the enrolment, and the kernel writes the whole message

- **The kernel composes every step's message, whole**: subject and body,
  as the person will read them.
- **The enrolment carries those messages**, one variable per step. At each
  step, the provider renders the variable as it was given, and writes
  nothing of its own into the copy.
  - *Fields.* `Enrolment.variables` changes meaning, from "what remains for
    the provider to resolve" to "what the kernel wrote".
  - *The provider's steps.* Each holds only the reference to its variable.
- **Each message is written before the enrolment**, through `writeMessage`
  (0038), one per step, keyed on the draft. `relations.message` keeps its
  nature: the kernel knows what was said, because it wrote every word.
- **A message is not a send.** A step can be stopped first, by a reply, a
  suspension or an unsubscribe. A message says what would be said. Only the
  touch the pull records says that it was.
- **Every enrolment carries its messages.** An enrolment with no message
  composed by the kernel is not made. The enrolment path that hands a
  sourced person to a sequence with no draft (`kernel-enrol` today) is
  ruled out. The person goes through drafting first.

### 3. The cap and the lane move to the enrolment

**The lane.** An enrolment that carries messages carries messages to
approve. Every step's draft is approved on its lane before the enrolment is
made (0027, 0042). The enrolment belongs to the drafts' experiment, and
says so (`attribution`).

**The cap is judged ahead.**
- *The commitment.* Enrolling someone in a sequence of five unsolicited
  steps commits to five unsolicited touches, at the times the steps'
  delays set.
- *The test.* The cap refuses an enrolment if any window of the cap's
  length, at any point of the plan, would hold more unsolicited touches to
  the person than the cap allows. The plan is counted with everything else
  that reaches them:
  - the touches already recorded;
  - the steps still planned of every other enrolment of theirs, in any
    sequence, on any channel.
- *A plan is replaced by what happened.* Once the touches pull records a
  step as sent, its touch counts at the time it left. The touches pull says
  only what left, never what will not.
- *What takes a step out of the plan* comes from two other sources, and
  only from them:
  - *a suspension*, which the kernel records itself (0051): the
    enrolment's remaining steps count no more;
  - *a reply*, which arrives through the inbound pull (0039). The
    remaining steps count no more only where the adapter says that its
    provider stops a sequence on a reply. Otherwise they stay planned,
    which errs toward refusing.
- *The count is by person*, never by sequence or channel, as it already
  is.

**Which way a plan errs, and what the touches pull adds.** A count from
the plan alone errs in two directions:
- *Toward refusing*, for the sequences the kernel made. A plan counts every
  step, and some will not leave. A suspension or a reply takes them out,
  as above; the touches pull does not.
- *Toward letting through*, for what the kernel did not plan: a send at the
  provider that no enrolment of the kernel's made. Only the pull, indexed on
  the person (0051), sees it.

The second direction is why the cap needs the pull, and the refusal below.

### 4. A channel is not a path

**A channel is a property of a sequence's steps, and of the adapter that
serves them.**
- *A sequence* may run on one channel or several: email steps, social
  steps, or both. Its steps say which.
- *A sequencer* serves the channels it declares (0014). The bindings take
  channels as before (0015).
- *Enrolment names a sequence.* It is routed to the adapter bound to the
  channels of that sequence's steps. A sequence whose channels are taken by
  two bindings is refused: one provider cannot run what two hold.

**What reaches a person is counted and refused per person, never per
channel.**
- *Sequences.* A person may be in two sequences on two channels.
- *The cap.* It counts both (section 3).
- *The objection.* It refuses every channel (0052, 0055).

### 5. Two verbs, one of them already decided

- **Read a sequence's steps — new.** For each step: its index, its
  channel, its delay after the previous one, and the variable it renders.
  This is the provider's side of the intention.
  - *Before enrolling*, the kernel compares the steps with the templates of
    the drafts it carries: as many steps, the same channels, the same
    delays.
  - *A disagreement refuses the enrolment.* A plan the provider will not
    run caps nothing.
- **Pull the touches — 0051's verb 2, which gets its method.** It says what
  happened: each send, its step and its own id, after a cursor, indexed on
  the person.
  - *Recording.* Each one is recorded as an outbound touch, unsolicited
    when its step was.
  - *Matching.* A touch is matched to its message by the enrolment's key
    and the step's index. This settles what 0050 left to "the real
    hand-over": a pulled send finds its message, and is counted once.

### 6. A second refusal, of 0051's form

**The kernel does not cap through an adapter that cannot pull its
touches.** For an unsolicited enrolment, the cap is required, with no
default (0038). So such an enrolment is refused through that adapter, as an
adapter that cannot suspend is refused (0051):
- before a run is opened;
- for a dry run too;
- with the declaration's own reason.

**A solicited enrolment needs no cap**, so it is not refused through that
adapter. It says that it is not capped, and why: the reply on the
`reactive` lane (0042). The report says so whenever it happens.

## The point this decision can fall on

**All of it rests on one thing nobody has observed: that a whole body,
passed as a variable, is rendered as given.** Sections 2 and 3 depend on
it. The kernel knows what was said only if the provider sends what the
kernel wrote. The cap counts a plan only if the steps carry the plan's
messages.

**The only two observations near it say that this provider damages what
it is given.** The shipped adapter's README recorded both:
- a body that mixes markup with bare text loses the bare text, at
  creation;
- the provider's own unsubscribe variable renders as an empty string.

Neither is a whole body in a variable, and neither proves that one would
be damaged. But they are all that was seen, and both point the wrong way.

**What settles it, and at what cost.**
- *Storage* is checked without a send. One long body is uploaded as a
  variable to a campaign that is never activated, then read back. It is a
  write to the workspace, made under the same conditions as the test the
  README records for the idempotency key.
- *Rendering* takes a send: a step leaves, and the received message is
  compared with what the kernel wrote, line breaks and markup included.

If rendering does not hold, this decision is reversed (*Would reverse
it*), not adjusted.

## What this does not reach

- **The full text of every step held at the provider.** The variables are
  kept on the lead. They name the person. Erasure stops the person (0056);
  what the provider keeps of a lead is what the adapter declares its
  suspension costs, and deleting it there is not done.
- **The steps a person edits at the provider after the check.** The
  comparison holds at enrolment, not after it.
- **Sends nobody records**, when no adapter of the instance pulls its
  touches. That is the refusal's reason, not a hole in it.

## Rules out

- A contact verb other than `enrol`, and the hand-over.
- An enrolment without messages written by the kernel.
- Copy written at the provider.
- An unsolicited enrolment without a cap, or capped from the window behind
  alone.
- An enrolment whose plan the provider's steps contradict.
- A cap counted per sequence or per channel.
- A cap through an adapter that cannot pull its touches.

## Would reverse it

- **A provider that does not render a variable as given.** The kernel
  would no longer know what was said, and section 2 falls with what rests
  on it (*The point this decision can fall on*).
- **A provider that sends only what it is handed, when it is handed it.**
  A hand-over would then have an object, and the cap could be judged at
  each send again.
- **A provider whose steps the kernel cannot read.** The cap would then be
  judged on the templates alone, and this decision would say what that
  costs.

## Not decided here

- **Where the unsubscribe link is.** If the kernel writes the whole body
  and the provider's unsubscribe variable renders empty, neither way
  carries the link.
  - *The body* does not: the kernel does not know the provider's link
    before the lead exists, and the variable that would give it renders
    empty.
  - *The header* may not either. The README records that the received
    email carried `List-Unsubscribe` and its one-click form. It does not
    record that the receiving client offered it to the reader.
- **The shapes**: of the steps verb, of the touches pull, of the planned
  times, and of how a message records the step it belongs to.
- **The registry row's channel** for a sequence on several channels. This
  needs a migration.
- **The draft's states after approval** (0027). `queued`, `sent` and
  `failed` had the hand-over as their writer.
- **Whether `kernel-enrol` keeps a form** for people from a sourcing run
  (0032), once drafting comes first.

## Not built yet

On `main` at `f927ab0`: none of it.
- The hand-over still stands in `send.ts`.
- `enrol` names a channel.
- No verb reads the steps.
- The touches pull has no method.
- The cap judges the window behind, at the message gate only.
- No refusal exists for an adapter that cannot pull.
