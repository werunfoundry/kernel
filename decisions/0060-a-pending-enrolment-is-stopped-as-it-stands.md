# 0060 — A pending enrolment is stopped as it stands

> Built by #106, in part: the trigger opens `pending` → `suspended` under an
> attestation only; an attestation never records `enrolled`; a pending row
> is confirmed only by its key, and one held under no key of the kernel's is
> stopped by address and left `pending`; `enrol()`'s reconciliation replays
> the key. 0057's act is still not built.

Supersedes in part [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md):
`suspended` is reached from `enrolled`, or from `pending` under a person's
attestation. Supersedes in part [0026](0026-the-enrolment-registry.md),
whose reconciliation confirmed a pending row on "a status by person and
sequence" — "enrolled there means confirmed here": a pending row is now
confirmed by its key, never by the person. Completes [0056](0056-erasure-stops-the-person-before-it-forgets-them.md),
whose attestation had no recordable outcome on a pending row, and
[0057](0057-a-newly-protected-account-is-stopped-when-a-run-looks.md),
whose act reached `enrolled` rows only.

## What was found

On `main` at `350656e`, and on the open pull request #106 at `90e2814`.

- **`pending` is written before the provider is called**, and reconciled
  on the next run (0026). Until then, the provider may hold the person or
  not, and the kernel does not know which.
- **The trigger lets only `enrolled` become `suspended`.** Run on a database
  migrated from `main`, a `pending` row given a complete suspension record
  is refused: "pending to suspended is not a move an enrolment makes; only
  an enrolled one is suspended (decision 0051)".
- **So 0056's attestation has no outcome on a pending row.** In the four
  cases where it opens, the provider either cannot be asked or does not
  answer, so nothing confirms that the row is enrolled. And the trigger
  refuses to suspend it as it stands.
- **#106 went round the trigger by writing something false.** Its
  attestation first records the pending row as `enrolled` — "the provider
  confirmed it", by the column's own comment — on a person's word alone,
  then suspends it. The registry then holds a provider's confirmation that
  no provider ever gave.
- **0057 suspends `enrolled` rows only.** A pending row at a newly protected
  account is left to the suppression, which 0057 itself calls defence in
  depth, not the record.
- **A read-back today finds a person, not an enrolment.**
  - *What the adapter writes.* The shipped sequencer adapter writes the
    kernel's key into the lead it creates, and compares it when it enrols
    again (`existing()` in `adapters/…/index.ts`).
  - *What it reads.* Its `status()` and `withdraw()` find the lead by
    address alone (`findLead()`).
  - *What the kernel does with that.* Its reconciliation (`enrol()` in
    `domains/acquisition/runtime/enrol.ts`) records a pending row
    `enrolled` on any status that is not `unknown`, so on an address.
  - *The consequence.* A lead someone else put in the same sequence with
    the same address — a colleague, another tool, the provider's own import
    — would confirm the row. The kernel would then record as its own an
    enrolment it did not make: the same fault as #106's attestation, by
    another path.

## Decided

**A read-back may confirm a pending row; a person's word never does.**

- **A suspension asked on a pending row asks the provider first**, as 0056
  has it for erasure. This now holds for every caller: erasure, the opt-out,
  and 0057's act.
- **What a read-back matches is the row's key, never the address.** An
  address names a person; the key the kernel gave names this enrolment.
  - *If the answer carries the row's key, as the provider holds it*, the
    row is recorded `enrolled`, then `suspended`. That is what happened: the
    provider confirmed this enrolment by being read.
  - *If the provider holds nothing for the person*, the row stays
    `pending`. There is nothing to stop, and no running sequence either: for
    0057, it is not one of the account's enrolments.
  - *If the provider holds the person, and the answer does not carry the
    row's key* — the lead has no key, another key, or the provider keeps
    none — the row is not confirmed.
- **What an unconfirmed row costs, and what it becomes.**
  - *The cost.* The kernel cannot tell its own enrolment from one someone
    else made with the same address in the same sequence.
  - *The person is still stopped.* The act stops what the provider holds
    for that address in that sequence, whoever put it there. An erased
    person, one who opted out, and one at a protected account must not be
    reached either way.
  - *The row stays `pending`.* That stop is never written on the row as
    its suspension, because nothing shows that the lead stopped was this
    enrolment. The run's report says it was made by address, and the
    provider's read-back is the only proof of it.
  - *Erasure goes on.* The person was stopped, and the row is anonymised
    as it stands (0053).
- **A run that reconciles a pending row confirms it the same way** (0026):
  by replaying its key, so that the provider answers this enrolment or a
  conflict. It never confirms on a status found by address.
- **An attestation stops a pending row as it stands: `pending` →
  `suspended`.** The trigger opens that move only for a row that carries an
  attestation and no read-back. An attestation never records `enrolled`.
  Nobody confirmed the enrolment, and the kernel does not write a provider's
  confirmation it did not receive.
- **0057 acts on pending rows too**, by the first point. A pending row it
  cannot settle — a configuration case, or a provider that does not answer —
  fails the act, naming the adapter, as an `enrolled` one does.

A suspended row that came from `pending` under an attestation reads exactly
as what it is: an enrolment nobody confirmed, which a person attested can no
longer send.

## Not built yet

On `main` at `350656e`:

- **none of it.** The trigger refuses `pending` → `suspended` whatever the
  row carries;
- **not on the open pull request #106 either.** It records a pending row
  as `enrolled` on an attestation, which this decision rules out, and as
  `enrolled` on a read-back found by address;
- **the shipped adapter's `status()` and `withdraw()`** find the lead by
  address and do not compare the key;
- **`enrol()`'s reconciliation** confirms a pending row on such a status;
- **0057's act is not built.**

## Rules out

- A row recorded `enrolled` on a person's word.
- A pending row confirmed by an address.
- A stop made by address recorded as the row's own suspension.
- `pending` → `suspended` without an attestation. On a read-back, the
  provider has confirmed the row, and it goes through `enrolled`.
- `suspended` reached from `refused`. Nothing of a refused row was sent.
- A pending row at a newly protected account left to the suppression alone.

## Would reverse it

**A provider whose enrolment answers synchronously**, so that no row is
ever left `pending` across a call. The state would then have no holder to
ask about, and this decision nothing to settle.

## Not decided here

- **How an answer says what it matched.** Neither `Withdrawal` nor
  `EnrolmentStatus` in `contracts/sequencer.ts` carries the key today, or
  says whether the lead was found by it. That is the contract's to add, and
  the adapter's to fill.
- **Whether a person may attest where 0057's act is refused.** 0056 opens
  the attestation for an erasure. 0057 has no such exit, and this decision
  does not add one.
