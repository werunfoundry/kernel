# 0065 — The kernel writes what is delivered, and every message says how to stop

> Built by #123, in part: the three declarations and their defaults, checked
> and printed; the shipped adapter declares plain text, a way out known
> after the upload, and a stop it does not class.

> Built by #124, in part: the unsubscribes pull has its method.

Completes [0064](0064-one-verb-reaches-a-person-and-carries-the-message.md),
whose kernel writes the whole message without knowing the form the
provider delivers, and leaves open where the unsubscribe link goes.
Completes [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
whose declaration gains what an adapter says of the way out and of a
reply that asks to stop. Rests on [0017](0017-inbound-is-pulled.md),
whose pull is how a reply would come back once something pulls the
sequencer's mailbox, which nothing does yet; on
[0047](0047-a-persons-acts-are-commands-at-a-terminal.md), whose terminal
is where a person records an objection read in a reply; and on
[0062](0062-the-register-is-written-by-its-domain-inside-the-erasure.md),
whose register only an erasure writes.

## What was found

The shipped sequencer adapter's README (`adapters/…/README.md`), sections
*A whole message in a variable* and *A whole message, sent*, on
2026-10-21. The README names the client and the provider; this decision,
which may name neither, refers to them there. One email went to
one address of the operator's and to no one else. Each fact below names
its source:
- *the provider's record*: `GET /api/v2/emails`;
- *the headers*: the MIME headers received, read by the operator;
- *the client*: the receiving client, which the README names, read by
  the operator;
- *the run*: the kernel's own test log.

- **Stored as given.** A lead's `custom_variables` came back byte for
  byte, by both of the adapter's reads.
- **Delivered as plain text** (the headers). The body arrived as
  `text/plain`, with no HTML part.
- **What survived** (the client):
  - *Kept:* line breaks, a non-breaking space, an emoji, the punctuation.
  - *Removed:* the markup.
  - *Gone:* a double space and a trailing space.
- **The provider's record is not what was delivered.** It records `<br>`
  for each line break and a plain space for the non-breaking one, and
  drops the emoji. The delivered message had all three as given.
- **Links are the client's.**
  - The URLs were clickable because the client turns text into links. The
    provider did not make them links.
  - A bare domain, `example.org`, became a link too (the client, one
    message).
  - Link tracking was off, set at creation. Its value was not returned on
    read-back. That no URL was rewritten is the client's evidence.
- **The header is not shown.**
  - *The headers* carried `List-Unsubscribe` and
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and SPF, DKIM and
    DMARC passed.
  - *The client* showed no unsubscribe affordance. October's send, in
    volume, showed none either.
  - *The reservation.* This one is a single message, which a client does
    not class as bulk. It counts for what it confirms.
- **The provider's link is known only after the upload.** The id in its
  unsubscribe URL is the lead's own id (the headers; the run). That id is
  known once the upload answers. The provider's variable for the link,
  `{{unsubscribe_url}}`, renders empty.
- **One hundred and one seconds** (the run). The campaign was activated
  at 22:29:48, and the provider dates the send 22:31:29. That measures a
  campaign activated with its lead already in it. It does not measure a
  lead added to a campaign already running, which is the window an
  enrolment would have.

On `main` at `72cf335`:

- **Nothing pulls this adapter's mailbox.** The only `Inbound` adapter in
  the repository is a CRM's. The shipped sequencer adapter has none, and
  0051's verb 4, the unsubscribes pull, has no method.
- **A reply is never read as an objection.**
  - *What inbound carries.* The `Inbound` contract
    (`contracts/inbound.ts`) carries "No message bodies" and does "No
    interpretation"; 0017 rules out "Copying a reply's body".
  - *What a reply records.* A reply arrives as `acquisition.reply`. Only
    `acquisition.unsubscribe` records an opt-out (`pullInbound`, through
    `recordOptOut`).
  - *Who else records one.* Besides inbound, `recordOptOut` is called by
    erasure alone. No command lets a person record an opt-out at a
    terminal.
- **An opt-out is not the register.** It writes `person.opted_out_at`.
  The register is written by an erasure alone (0062). The one reader reads
  both (0055).
- **The kernel has no public surface.** Its HTTP API (0040) refuses every
  request without the instance's token and "accepts no event". 0017 rules
  out "a webhook endpoint in the kernel".

## Decided

**Why the rules are an adapter's declarations, not a provider's case.**
There is a channel on which no unsubscribe link exists: a social
network's messages. A kernel that required a way out in every body, or a
rule written around one provider's link, could not use a sequencer on
that channel at all. So every rule below is an adapter's declaration and
the kernel's answer to it, in 0051's form, and a provider with no link
answers "none" like any other.

**Each declaration has its default, as 0051 has it: nothing said is not
"yes".** An adapter that does not fill one is held to the answer below
that assumes the least.

### 1. The kernel writes the form the provider delivers

**An adapter declares the form its provider delivers a body in.** The
kernel writes its messages in that form, and the message it records
(0064) is the message delivered.

**Its default is a body that reads the same in either form.** Nothing
said is not "markup survives", and it is not "line breaks survive"
either.
- *Two ways to lose a body.* A delivery may remove what it does not keep,
  as plain text removed the markup above. It may also collapse what it
  renders as HTML: the provider's documentation says "Use `<br/>` tags for
  delivered email line breaks", so a plain-text body rendered that way
  arrives as one block.
- *What the kernel writes then.* A body whose meaning depends on neither:
  - no markup;
  - no line break that carries meaning;
  - single spaces, none trailing;
  - links as bare URLs.

  Nothing is lost in either direction.

**For the shipped adapter, plain text:**
- *No markup.* It is removed on delivery.
- *No double space and no trailing space.* They do not survive.
- *What it keeps:* line breaks, non-breaking spaces, emoji and
  punctuation, which arrive as written.
- *Links as bare URLs.* Whether one becomes a link is the client's to
  decide, as it decided for the bare domain above.

### 2. The way out in the body: declared by the adapter, added by the kernel

**An adapter declares the way out its provider offers in a body**, and
when it is known. There are three answers:
- *Known before the first call.* The kernel sends the body complete, in
  one call.
- *Known only after.* The kernel writes it in once the adapter returns
  it. The adapter declares the window it has before its first step can
  leave.
- *None.* The adapter says so. That is a declared fact of its provider,
  not a failure.

**Its default is "none".** Nothing said is not "known before". The kernel
then writes no way out into the body, and the enrolment records that its
body carried none and why: the adapter said nothing. As with a cut, the
absence is in the data.

The shipped adapter answers *known only after*: the lead's id comes back
with the upload. The only window measured is the one above, and it is not
the one an enrolment has.

**The kernel adds the way out itself, unless the instance cuts it.** The
kernel puts it in the composed body; the author of the message does not
have to think of it.

**An instance may cut it, and the cut is recorded on the enrolment.** An
absence is a fact written, not a lapse. The day someone asks whether this
person could stop us, the answer is in the data, not in the memory of
whoever set up the sequence. A suspension records what it cost in the
same way (0051). There is no guard and no refusal. The fact beside that
choice is recorded in the adapter's README: cut, the only way out is the
header, which the client measured does not show.

**The kernel serves no link of its own.** A link that reached the kernel
would need a public surface, reached without the instance's token,
receiving a person's act: a push. 0017 and 0040 rule that out, and this
decision does not change them. 0017's reason holds here: a push missed
while the surface is down leaves no trace, and a pull that stops is seen.

**The provider's header stays.** The One-Click header remains, for the
clients that show it. What a click on the provider's link or header
records, the unsubscribes pull reconciles (0051, verb 4).

### 3. A reply that asks to stop

**An adapter declares whether its provider classes a reply asking to stop
as an unsubscribe.** It sits in 0051's list, beside what it cannot do.
0051's rule holds: nothing said is not "yes". Until an adapter has proved
it, the kernel holds that its provider does not class.

**Where the provider does not class, a person does — not the adapter.**
- *What the contract protects.* "No interpretation" keeps the kernel from
  becoming a processor of content.
- *Lifting it once lifts it twice.* A contract rule lifted for one case
  is lifted for the next.
- *Recognising a stop in free text fails silently.* "Thanks, but not
  now" is not a stop, and an adapter would let a stop worded otherwise
  through without anyone seeing it. That is the failure 0017 is written
  against.

**The form is a queue, not a parser.**
- *The adapter.* It interprets nothing, and goes on emitting
  `acquisition.reply`.
- *The terminal.* It shows the replies, and a command records the
  objection (0047).
- *What that gives.* A person's act, dated and attributable, with no
  contract touched.

**Where it lands.** On `person.opted_out_at`, which the one reader reads
(0055). Never on the register, which only an erasure writes (0062).

**"Reply STOP" is written into a body only once that path exists.** That
needs an inbound source for the sequencer's own mailbox, and the command
to record the objection. Neither exists on `main`. Writing the phrase
before would promise a way out that reaches nothing. The provider might
stop its own sequence on the reply. Every other sequence, and every other
provider, would keep writing to someone who asked to stop.

### 4. Link tracking is a declared unknown, not a refusal

**The kernel does not refuse a sequence whose link tracking is on.**
- *The way out survives it.* No link of the kernel's crosses the
  provider. A rewritten provider link still lands at the provider.
- *0051's refusal is not this one.* It turns away an adapter that cannot
  suspend. The shipped adapter can suspend. Refusing it here would stop
  the only adapter there is, for a risk that does not stop anyone being
  reached.

**What tracking does cost, and is not known.** With tracking on, the
provider rewrites the URLs in a body, and the kernel's other links with
them. The message the kernel records would then carry the URL it wrote,
where the person received a redirect. 0064 says the kernel knows what was
said; for a message with links and tracking on, that holds for the words
and not for the URLs. That rendering was never measured.

**Three ways of knowing the setting, all closed:**
- *Reading it.* The campaign's read did not return `link_tracking`.
- *A person declaring it in the binding.* That is a declaration where 0051
  asks for proof. The first operator to tick it without knowing makes
  every check that rests on it decorative.
- *Measuring its effect in the touches pull.* The pull returns the body
  the provider records as sent, and a rewritten URL would show there. But
  that record is not what was delivered: it changed three things the
  delivered message kept. A URL intact in the record proves nothing about
  the URL delivered.

## What it rests on

**Everything measured was measured with link tracking off.** The
plain-text form, the bare URLs, and the provider's link carrying the
lead's id held under that one setting.

## The cost

- **A reply is less convenient than a click.** Some people who want to
  stop will not write.
- **A queue waits for a person.** An objection in a reply holds until
  someone reads it. Until then, every sequence of the kernel's keeps
  writing.
- **A cut way out is a choice with a known consequence.** The header is
  then the only way out, and the client measured does not show it.

## What this does not reach

- **The rendering with link tracking on**, as above.
- **Clients other than the one measured**, and that client on a send it
  classes as bulk from this provider.
- **The window an enrolment has.** A step that leaves before the way out
  is written in carries none. The window measured is not that one.
- **An objection between the provider's record and the unsubscribes
  pull.** Until the pull reads it, every other sequence keeps writing.

## Rules out

- A message written in a form its provider does not deliver.
- A way out cut without the enrolment saying so.
- "Reply STOP" in a body before a path carries the reply to the opt-out.
- A reply interpreted by an adapter or by the kernel.
- An adapter's silence read as anything but the default that assumes the
  least: a body that reads the same in either form, no way out, a
  provider that does not class a stop.
- A link served by the kernel, while 0017 and 0040 stand.
- The provider's record of a send taken as what was said.
- Link tracking known by a person's declaration, or by the provider's
  record of a send.

## Would reverse it

- **A client that shows the header to everyone** the kernel writes to.
  The body's way out would then be a second one, not the only one read.
- **A provider that delivers what it records.** Its record could then be
  read as what was said, and as a measure of tracking.

## Not decided here

- **The shapes**: of the delivered-form declaration, of the way-out
  declaration and its window, of the stop-classing declaration, and of
  the cut recorded on the enrolment, which needs a migration.
- **The inbound source for a sequencer's mailbox**, and the command that
  records an objection read in a reply.

## Not built yet

None of it:
- no adapter declares a delivered form, a way out or a stop-classing;
- nothing writes the way out into a body;
- nothing records a cut;
- the unsubscribes pull has no method;
- nothing pulls the sequencer's mailbox, and the command does not exist.
