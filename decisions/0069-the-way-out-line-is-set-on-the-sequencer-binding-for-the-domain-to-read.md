# 0069 — The way-out line is set on the sequencer's binding, for the domain to read

Completes [0067](0067-the-way-out-is-recorded-on-the-enrolment-after-the-body.md),
which left undecided where the instance declares the line's wording, and
what the kernel does with an instance that declares none. Rests on
[0065](0065-the-kernel-writes-what-is-delivered-and-every-message-says-how-to-stop.md),
whose cut is the instance's choice, recorded on the enrolment; on
[0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
for which a declaration is not a proof; and on
[0035](0035-what-a-domain-is.md), whose core holds no word of a domain's.

## What was found

- **An instance declares what it binds in `manifest.yaml`**, one binding
  per contract and channel. A binding has the adapter's `options`, handed to
  the adapter, and `channels` and `finds`, which the core reads.
- **The core's types hold no business word** (doctrine 1). A field for a
  message's closing line, on the core's binding, would be one.
- **A domain already contributes what the core loads without reading it**:
  its channels, its truth kinds, its event types, declared in `domain.yaml`.

## Decided

### 1. A setting on the binding, declared by a domain, loaded by the core

**A domain declares the settings an instance may put on a binding of a
contract it reads**: `bindingSettings` in `domain.yaml`, a contract and a
key each. The instance sets them under the binding's `settings`, in a
section named after the domain that reads them: `settings.acquisition`.
The core reads none of the values. The domain reads them, and the adapter
is never handed them.

**What the core checks, and what it does not.**
- Under an enabled domain, a key that domain does not declare for the
  binding's contract is refused at boot: a misspelt setting is a setting
  not applied.
- Under a domain that is not enabled, nothing is read, and the instance
  boots with a warning. A domain disabled with its settings left in the
  manifest is not a lock — the shape 0058 gave the register's versions, and
  0063 had to bound after the fact.

Acquisition declares one: `wayOut`, on a sequencer binding. Its value is a
line, `{ line: "…{link}…" }`, with `{link}` once where the provider's link
goes, on one line; or `cut`.

### 2. Not the adapter's options

In the adapter's options, the line would reach the kernel only through the
adapter's declaration. What the kernel records as added to a message would
then depend on the adapter reporting it faithfully. A declaration is not a
proof (0051), and the sentence a person reads cannot be held by the layer
that talks to the provider.

### 3. Not the experiment's, though its language argues for it

The line should be in the language and the register of the message, and the
language varies by experiment, not by channel. But the line is not creative
copy: it is what makes a sequence stoppable, and it must not be forgettable
each time an experiment is made. Set once on the binding, it is there for
every experiment.

### 4. None declared: enrolled, recorded, and said aloud

**An instance that declares none enrols with no way out.** Each enrolment
records the absence and why: no line declared (0067 §3). It is not refused
(0065 §2).

**The run says it, every time**: so many people enrolled without a way
out, because no line is declared, as protection names the accounts it
cannot reach. Not refused, and not silent: one column is not a trace anyone
reads.

**The kernel writes no line in its place.** A default line would be words
nobody read, put in someone's message.

**The shipped template declares one**, so that a new instance is not
silent by accident.

### 5. The language limit, declared and not resolved

One line per binding is one language per channel. An instance that needs
several languages on one sequencer cannot have them today. The way out is
named and not built: a line carried by the experiment, taking precedence
over the binding's. Nothing is built for a need nobody has measured, and
nobody is surprised by the limit either.

## Rules out

- **A line declared without `{link}`, or with it twice.** "To stop
  receiving these messages, click here" with no link behind it is a
  promise of a way out with no way out, worse than no line: the family of
  "reply STOP" before its path existed, which 0065 §3 refused for that
  reason. The core does not read the value, so boot cannot refuse it; the
  enrolment does, before a run is opened, a dry run too, and nobody is
  enrolled.
- The line in the adapter's options, or anywhere the adapter reports it.
- A word of a domain's in the core's binding type.
- A line written by the kernel when the instance declares none.
- An enrolment without a way out that the run does not say.
- A key under an enabled domain that it does not declare for the contract.
- An instance that cannot boot because a domain it disabled left settings
  behind.

## Would reverse it

- **A core that could carry a domain's words.** A field on the core's own
  binding would then do, and the mechanism of section 1 would be needless.
- **A provider that puts its link in the body itself**, in a form the
  kernel can read back. The line would then be the provider's, and the
  instance would declare none.

An instance that needs several languages on one sequencer does not reverse
this: it makes it insufficient, and section 5 already names what is added
then — the experiment's line, over the binding's.

## Not built yet

The core loads and checks the settings, acquisition declares `wayOut` and
reads it, and the template declares a line. The enrolment does not use it
yet: refusing a line without its link, writing the line after the upload,
recording it on the enrolment (0067), and saying aloud who went without one
come with 0067's record.
