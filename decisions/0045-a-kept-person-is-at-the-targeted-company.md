# 0045 — A kept person's address is at the company that was targeted

> Completed by [0046](0046-the-addressing-domain-is-acquisition.md): the domain
> called `gtm` here is `acquisition`; read `gtm.x` as `acquisition.x`.

Completes [0031](0031-the-sourcing-path-and-the-crm-as-exclusion.md), whose
person pass checked the completed identity against protection and the CRM
but never against the company it was sourced for.

## Decided

**After completion, every address a person carries must be at the targeted
company.** An address's domain matches the targeted company's domain when it
is that domain or under it — the same ancestor walk protection uses (0044):
`@eu.bardeen.ai` is at `bardeen.ai`. A person with an address elsewhere is
excluded, with the outcome `off_target`, and the detail names both: where
the address is, and which company was targeted. Every address, not one: a
person is recorded with all the addresses completion attested, and whatever
contacts them later may use any of them.

**Placed after protection and before the CRM.** Protection is the stronger
reason, and is said first when both apply. Excluding before the CRM spares
a lookup the person could not pass anyway.

**The person is not filed under their real company.** The target list
chose the company; a people source listing someone under it — a past or
second position — does not make the company they now work for a target.
The person is excluded, not moved.

## Why

On the instance's first two live runs, 4 of the 14 people kept had a work
address on another company's domain. The people source lists them at the
targeted company; completion returns where they are now. Each was recorded
under the targeted company and would have been enrolled as one of its
people.

## Not done here

- **The credit is already spent.** The mismatch is only known once
  completion has answered, and today nothing can tell it earlier: the
  people source returns, for each person, an id, a handle, a name and a job
  title — no company and no domain — and its contract carries no such
  field. Detecting the mismatch before paying means extending that
  contract with the person's current company, which is a decision of its
  own.
- **Aliases.** A company with a second domain the target list does not
  carry will see people on that second domain excluded. That is the safe
  direction: excluded, never contacted under the wrong company.
- **Enrolment from a sourcing run** (0032) re-reads protection, addresses
  and the opt-out, not this. People kept before this decision are kept in
  the record until someone decides what to do with them.
- **`off_target` cannot be dropped from the enum** once migrated (0044's
  note applies: PostgreSQL does not drop an enum value).

## What the 4 people showed about forgetting someone

The 4 people kept before this decision were deleted, by hand: they were
identified under a premise this decision rules invalid, and never contacted.
Doing it showed that **a person's identifying data lives in two places**:
`relations.person`, and every `gtm.sourcing_result` row that kept or
excluded them, which holds their keys (address, network id and handle) and
the address inside what the provider said. `relations.person` is not their
only owner.

`kernel-erase` (0040) exists, and does not do what was needed here. It
deletes the sourcing rows that reference the person, where the record of
what each run did should stay and only the identity should go. And it does
not reach the rows that name a person by keys alone, such as a skip or an
excluded result. So there is today no operation that forgets a person while
keeping the record. It was rebuilt by hand, in one transaction: the
reference set to null, the key values and the address removed from the 4
sourcing rows (outcome, detail, cost, run and the provider's status kept),
then the 4 people deleted.

**The same addresses were found in four places, one after the other**: in
clear in `relations.person`; as keys in `gtm.sourcing_result`; as a hash in
that row's `subject`, which anyone holding a candidate address can test;
and in copies outside the database — the run logs kept while measuring. A
backup taken earlier happened not to hold them only because it predated the
runs. An erasure command that covers the tables alone will be believed
complete, and will not be. It must reach the operational layer, backups and
logs, or say in so many words that it does not.

**The next time will not be an internal correction, but a real person's
request to be erased.** Answering it is a decision of its own, to be taken
after the single door to people search, enrichment and the sequencer, on the
form that door gives the protected actions.

## Rules out

- A kept person whose address is at another company than the one targeted.
- Re-filing a person under the company their address names.

## Would reverse it

A target list that targets people rather than companies — then where they
work now is the point, and the company is a property of the person.
