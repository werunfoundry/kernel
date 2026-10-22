# 0067 — The way out is recorded on the enrolment, after the body

> Completed by [0069](0069-the-way-out-line-is-set-on-the-sequencer-binding-for-the-domain-to-read.md):
> the line's wording is set on the sequencer's binding; with none, the
> enrolment records the absence and the run says it.

Supersedes in part [0065](0065-the-kernel-writes-what-is-delivered-and-every-message-says-how-to-stop.md),
its section 1, in form and not in guarantee: the message delivered is no
longer one record, it is two. The guarantee stands: the kernel knows what
was said. It also completes 0065's section 2, whose way out known only
after the call had nowhere to be recorded, and whose cut and absence on
the enrolment are joined here by what else the enrolment holds. Rests on
[0064](0064-one-verb-reaches-a-person-and-carries-the-message.md), whose
messages are written through the gate before the enrolment, and on
[0038](0038-a-message-is-recorded-in-relations-behind-its-own-gate.md),
whose message is never rewritten.

## What was found

- **The link is known only after the enrolment.** The shipped sequencer
  adapter's README, sections *The throwaway campaign of 2026-10-22* and
  *The way out, written after the upload*:
  - the provider's link holds the lead's id, which comes back with the
    upload, and a lead id the caller chooses is not kept;
  - a lead's variable rewritten after the upload, with the link, was
    accepted, read back, and is what the message received carried;
  - the rewrite landed 147 ms after the upload; the first step left 156
    seconds after it on one run and 382 on the other. Comfortable, and not
    a bound.
- **A message is never rewritten.** `relations.message` refuses an update
  (migration `0009`, decision 0038).
- **So 0064 §2 and 0065 §1 cannot both hold, as written, for that
  adapter.** A message written before the enrolment, as 0064 has it, cannot
  hold a link that exists only after it; and it cannot be completed later.

## Decided

### 1. Two records, one message

**What 0065 §1 protects is that the kernel knows what was said, not that
it is one row.** Two records that are never rewritten, whose concatenation
is the message delivered, keep that guarantee whole. The form of the record
changes; the property does not.

- **The message** holds the body the author wrote and the lane approved,
  written through the gate before the enrolment (0038, 0064 §2). It does
  not change.
- **The enrolment** holds the way out the kernel added, or why there is
  none (section 3).
- **The message delivered** is the message's body followed by the
  enrolment's way-out line.

**The closing rule, which holds the rest.** What follows the body is
exactly the way-out line, and nothing else. The kernel appends it at the
end, after the gate has passed the body, and adds nothing more: no greeting,
no tracking, no second line. Without this rule the guarantee would decay
into "the body, plus whatever was added".

**The instance writes the line's wording; the kernel guarantees the link
in it.** A delivered form that removes markup (0065 §1) leaves no room to
style it; how it reads is the instance's, and that it carries the
provider's link is the kernel's.

### 2. Why not write the message after the enrolment

The message could be written once the link is known, the link inside it.
The gate — consent, cadence, lane — would then rule after the provider had
been reached, and a refusal would mean suspending someone just enrolled. A
gate that rules after the provider has been reached is no longer a gate.

### 3. What the enrolment records of the way out

Three states, each a fact written once, none presumed:

- **Written** — the line, the link, and when the rewrite was read back;
- **Cut** — by the instance, and that it was (0065 §2);
- **Absent** — the adapter declared none, or said nothing, or the rewrite
  could not be made, and why.

**An absence is not chosen before enrolling.** When the rewrite fails, the
person is already enrolled: the upload came first. What is decided is that
they are not suspended for it. The absence is recorded and the enrolment
stands (0065 §2: the way out is not forced, by this path or any other).

**Two times, and what they establish.** The enrolment keeps when the
rewrite was read back. The touches pull keeps when the first step left
(0051's verb 2, 0064 §5), and it reads that up to six minutes late.
*Written too late* is not a state: it is what the two times establish,
when the first step left before the read-back. Recorded as a state, it
would have to be written onto the enrolment once the pull came back — the
rewrite section 1 rules out. Whether a person received the way out is
answered from the two times, after the fact, never presumed from a window
nobody bounded.

### 4. The alternative set aside: a way out reserved before composing

0064 §2 and 0065 §1 could both have stood unchanged with a fifth verb:
reserve the way out before composing. For the shipped adapter, that would
mean creating the lead in a holding campaign, reading its id, composing the
body with the link, then moving the lead into its sequence.

It is set aside. It imposes a verb, and a manoeuvre nobody has measured, on
every adapter — including those whose link can be composed in advance — to
reach the same guarantee section 1 keeps with two records.

## Rules out

- Anything after the body but the way-out line.
- A way-out line added before the gate has passed the body.
- A message rewritten to hold its link.
- A gate that rules after the provider has been reached.
- Whether a person received the way out presumed from a window.
- *Written too late* recorded as a state, and the enrolment's way-out
  record rewritten to say so.
- A verb that reserves a way out before composing.

## Would reverse it

- **A message record that can be completed once, append-only in all but
  that.** The way-out line could then live on the message, one record
  again, with the same guarantee.
- **A provider whose link is known before the call** for every adapter
  there is. The line would then be in the body the gate passes, and the
  enrolment would record only a cut or an absence.

## Not decided here

- **The shape** of the way-out record on the enrolment, and its migration.
- **Where the instance declares the line's wording**, and what the kernel
  does with an instance that declares none.

## Not built yet

None of it: the enrolment records no way out, and nothing appends one.
