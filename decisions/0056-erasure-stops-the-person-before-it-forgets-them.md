# 0056 — Erasure stops the person before it forgets them

Completes [0040](0040-an-http-api-and-erasure-declared-per-domain.md),
whose domains declare what erasure does to their tables and nothing it does
elsewhere; [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
whose suspension nothing calls; and
[0053](0053-an-enrolment-is-history-once-its-person-is-erased.md), whose
anonymised row was meant to be the proof that a suspension came first.

## What was found

On `main` at `170f4a2`.

- **Erasure calls no adapter.** `erase()` (`core/runtime/erase.ts:237`)
  carries out the domains' table rules, in one transaction, and takes no
  registry of bound adapters. What it does not reach says so: a person
  enrolled in a running sequence stays in it, and its next steps still
  reach them (`erase.ts:60-64`).
- **Nothing that erases can reach the sequencer.** The core references no
  domain (doctrine 2). `kernel-erase` lives in `relations`
  (`domains/relations/bin/erase.ts`), which does not depend on
  `acquisition`. The only code that knows which sequencer holds a person
  is `acquisition`'s.
- **The anonymised row no longer says where to stop them.** Since 0053 it
  names nobody. An erasure that does not stop the person first leaves the
  kernel unable to stop them afterwards.
- **A `pending` row may be held by the provider**, and 0051's trigger
  lets only an `enrolled` row become `suspended`
  (`domains/acquisition/db/schema.ts:50-60`).

## Decided

**A domain may declare a step that runs before erasure.** It declares it in
its `domain.yaml`, beside its erasure rules, naming a module of its own
package. The core loads that module the way it loads an adapter (0023): by
resolving what the declaration names, never by importing a domain. The
core gives the step:

- the subject;
- the keys gathered for erasure;
- the bound adapters;
- the erasure's run;
- whether this is the plan or the act.

The step answers act by act: what it did, how many rows, and through which
binding.

**The core runs every step before any rule, and outside the transaction.**
- *The order.* Upper domains go first, the order the rules already follow
  (`erase.ts:68`).
- *Why outside.* A call to a provider cannot be rolled back with a
  transaction, and must not hold one open.
- *Then the rules.* Once every step has finished, the transaction opens and
  the rules run as they do today.

**It fails closed.** If one step fails, nothing is erased: the transaction
never opens, and the run ends failed. The refusal says:

- **which adapter failed**: its contract, the binding it was reached
  through, and what it answered;
- **that running the erasure again is the remedy.** A step that completed
  stays done and recorded: a suspension is terminal (0051). The retry finds
  it done, and does not ask the provider again.

When retrying cannot fix it, the refusal says so, and names what would. Three
cases are of that kind: no adapter is bound to the row's channel; the
binding is to a provider other than the one the row was made through; or the
binding declares that it cannot suspend. A provider that never answers
again — an account closed — is a fourth.

**In those four cases only, the way out is a person's act, never a
renunciation.** A person attests at a terminal, under their name, that the
enrolment can no longer send. The erasure then goes on because the stop
happened, not because anyone gave up on it.

In every other case, the remedy is to retry. No attestation is open there:
a timeout, a refusal or an error that retrying may clear is retried.

- *Where it opens.* The first three cases are in the instance's
  configuration, and the kernel sees them. It opens the attestation only
  for an enrolment it finds in one of them. The fourth it cannot tell from
  a timeout, so it opens only for an enrolment an erasure has already been
  refused on. There, the case itself is part of what the person attests.
- *What it says is what the person affirms, and that differs by case.*
  - Where the provider still runs: "I stopped this person in this
    sequence, by hand, this way."
  - Where the account is closed: "The account is closed; no sequence can
    send any more."

  There is no single formula for different facts. An attestation names one
  enrolment, never the erasure as a whole.
- *Its form is 0047's.* A person's act is recorded as a person's act, and
  never deduced.
- *An attestation can be false*, as any attestation can. The registry says
  who gave it.

**The registry tells an attested stop from a proved one.** 0051 made the
suspension's record a proof: a suspended row holds what the provider
answered when the stop was read back, in `suspension_read_back`, and the
schema requires it (`enrolment_suspension_recorded`). An attested stop has
no such answer. It has a person's word.
- *An attestation never goes in `suspension_read_back`.* That column holds
  only what a provider returned.
- *It goes in a column of its own, `suspension_attestation`.* That column
  holds what the person affirms and the case it answers. The stop is
  recorded under a run the person opened, so the run's attribution says
  who.
- *The constraint changes accordingly.* A suspended row holds exactly one
  of the two: a read-back, with the adapter's method and costs, or an
  attestation.
- *Erasure treats it as it treats the read-back.* The attestation may name
  the person, so 0053's anonymisation replaces it with a fixed document.

A stop that was verified and a stop that was affirmed are never read as
the same thing.
- *Erasing anyway, saying what was not stopped, is not a way out.* It turns
  a delayed erasure into a contact without end and without remedy. The
  kernel forgets the person, the sequence keeps running, and nobody knows
  where to stop it any more.

A decision that creates a block says how one leaves it. This is how.

**`acquisition` declares one step: suspend every enrolment a provider may
still hold.**
- **`enrolled`** is suspended through the sequencer bound to its channel,
  as 0051 has it. The step reads it back, and records it in the registry
  under the erasure's run.
- **`pending`** is first asked of the provider. A row the provider holds is
  recorded `enrolled`, then suspended. A row it does not hold stays
  `pending`.
- **`refused` and `suspended`** leave nothing to stop.

Then the transaction anonymises every row (0053), the read-back included.
The anonymised row is the proof that the person was stopped before they were
forgotten.

**The plan says it too.** `kernel-erase --plan` lists each step: what it
would do, to how many rows, and through which binding. It calls the adapters
as a dry run, which reads and writes nothing.

**What erasure does not reach changes.** The sequencer's line in
`NOT_REACHED` goes. In its place, two lines:
- the steps the provider had already scheduled to leave before the
  suspension took effect (0051);
- what the provider keeps of the person, as the adapter's declared costs
  say.

## What it does not reach

- **A provider that never answers again**, such as an account closed. The
  erasure stays refused until a person attests the stop (above). Until
  then, the person stays on record.
- **Erasing the person at the provider.** The step stops them; it does not
  delete them there. What the provider keeps is what the adapter's
  suspension declares it keeps (see *Not decided here*).
- **A suspension that held at the provider, whose record did not commit.**
  The retry asks again. An adapter that parks reads the lead back as
  already parked, and parks it only once.
- **An erasure that does not go through `erase()`.**

## Rules out

- An enrolment anonymised while a provider may still be sending to it.
- A call to a provider inside the erasure's transaction.
- The core importing a domain's code.
- An erasure that goes on when a step did not complete, unless a person
  attested the stop in one of the four cases.
- An attestation where retrying may still work.
- A person's affirmation recorded where a provider's answer belongs.
- An erasure that goes on because someone gave up on stopping the person.
- A stop by hand deduced rather than attested.
- A refusal that does not name the adapter that failed.
- **Suppressing the person at the provider instead.** It would write the
  erased person's address into the provider's blocklist, and keep there
  what erasure removes here. 0052's register is the kernel's answer to
  remembering an objection, and it holds a keyed fingerprint, not an
  address. [0057](0057-a-newly-protected-account-is-stopped-when-a-run-looks.md)
  makes the same write for the people of a newly protected account: there,
  the address stops a contact with someone still on record; here, it would
  keep a datum about someone the kernel has forgotten.

## Would reverse it

**A contract verb that erases a person at the provider and reads that
back.** The step would then erase there, not suspend. The order would stay:
the person is reached at the provider before the kernel forgets where.

## Not decided here

- **The shapes**: the manifest's field, the step's signature, what the plan
  prints, and the attestation's command.
- **Deleting the person at the provider rather than suspending them.** This
  is not a question of the kernel's design. It is a question of processing:
  what the agreement with the provider obliges it to do with a datum, and
  what its API allows. The live test behind 0051 showed that deleting a
  person there leaves the messages already sent, pointing to an id that no
  longer exists: a deletion at the provider is partial anyway. The question
  is taken up with the processing agreements, not with a decision of the
  kernel.
