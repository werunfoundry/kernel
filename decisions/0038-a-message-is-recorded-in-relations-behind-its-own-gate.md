# 0038 — A message is recorded in `relations`, behind a gate of its own

> Completed by [0041](0041-which-fact-governs-a-guard.md): the opt-out stays
> global, and closes rather than serves.
>
> Completed by [0042](0042-a-reactive-reply-is-licensed-by-the-persons-inbound-touch.md):
> `lane:reactive` is accepted on the same license.

Completes [0027](0027-a-draft-waits-on-its-lane.md), whose gate is on the
draft.

## Decided

**`relations.message` records what is sent to a person**: this content, to
this person, on this channel, from this sender, handed over to be sent at
this moment. That is true whichever domain sends it — a support answer, a
release announcement, a follow-up — so it lives below all of them (0035).
Appended, never updated: what happened to it afterwards (delivered,
bounced, replied) is a touch. A message names the experiment it belongs
to, if any, and carries a key the writer gives, unique in the DDL, so a
replayed write is one message.

**The addressing domain's `message` was a template, not a message.** It is
one step of one variant of one sequence, with no recipient — the factory,
which stays in the addressing domain beside `draft`, `enrolment` and
`sourcing_result`. It is renamed `gtm.template`, and `draft.message_id`
becomes `draft.template_id`, so that "message" means one thing. Nothing
wrote either; the migration refuses to run where something did.

**Writing a message is a gate, beside the draft's.** The draft asks
whether the content is approved (0027). Writing the message asks whether
sending it is lawful, and refuses, all at once:

- **Consent.** A person who opted out. The opt-out is global today, so it
  refuses every message, solicited or not, until consent is per purpose.
- **Cadence.** An unsolicited message past the solicitation cap. The cap is
  the caller's — a number and a window, with no default — and counts the
  unsolicited messages to that person in the window. A solicited message
  (an answer the person asked for) is never held back by it.
- **Lane.** A message written by anyone but a person must carry an approval:
  a person's name, or the lane's. The lane's is `lane:autonomous`, valid
  only for an experiment whose lane is still `autonomous` and which is
  running; or `lane:reactive`, which is refused until the engine can verify
  an inbound event from the same person (0017, 0027). Without an
  experiment, there is no lane to approve, and a person must have.

The schema holds the lane's half: a message whose actor is not a person and
which carries no approval is refused by a check, whoever writes the row.

The two gates add up, never replace each other. A domain that makes no
draft still writes its message through the second; a draft approved by its
lane still passes the second when its message is written.

## Not done here

- **The sending path is not built** (0027): nothing writes a message from a
  queued draft yet. When it is, it writes through this gate.
- **Sends a sequencer makes on its own**, once a person is enrolled, do not
  pass through a message write today, and so not through this cap. When
  touches say whether they were solicited, the cap should count them too.
- **Protection is not part of this gate.** It is a rule of the addressing
  motion — do not prospect a customer — and an answer to a customer's
  question must not be refused by it.
- **The autonomous streak is not re-checked here.** Whether a lane approval
  stands once the streak has dropped is still open (0027, *Not decided*);
  this gate only checks that the lane has not changed.

## Closes

The first tension in `docs/domains.md`: constraint 1 is written.

## Rules out

- A message written to an opted-out person, by any domain.
- An unsolicited message with no cap given.
- An agent or a system sending without an approval it can name.
- "Message" naming a template.

## Would reverse it

Per-purpose consent (constraint 2) changes the first check, not the gate.
A sending path that cannot write before it sends — a provider that only
reports afterwards — would make the message a record of what happened
rather than a gate on what may, and the gate would move to whatever hands
the send over.
