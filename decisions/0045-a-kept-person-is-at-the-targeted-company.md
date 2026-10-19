# 0045 — A kept person's address is at the company that was targeted

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
  completion has answered. Detecting it before paying needs the people
  source to say each person's *current* company — a field the contract does
  not carry today — and that is a contract change of its own.
- **Aliases.** A company with a second domain the target list does not
  carry will see people on that second domain excluded. That is the safe
  direction: excluded, never contacted under the wrong company.
- **Enrolment from a sourcing run** (0032) re-reads protection, addresses
  and the opt-out, not this. People kept before this decision are kept in
  the record until someone decides what to do with them.
- **`off_target` cannot be dropped from the enum** once migrated (0044's
  note applies: PostgreSQL does not drop an enum value).

## Rules out

- A kept person whose address is at another company than the one targeted.
- Re-filing a person under the company their address names.

## Would reverse it

A target list that targets people rather than companies — then where they
work now is the point, and the company is a property of the person.
