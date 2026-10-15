# 0019 — The enrolment path, with protection in it from the start

> Completed by [0026](0026-the-enrolment-registry.md): enrolments and skips
> are recorded, written before the provider is called.

Completes [0004](0004-protection-is-its-own-route.md), which decided that
protection is its own route and is re-checked at enrolment, and
[0012](0012-one-provider-workspace-per-instance.md), which made that check the
kernel's and not a provider's.

## Decided

`gtm` gains the enrolment path, `domains/gtm/runtime/enrol.ts`. In one
recorded run it does five things, in this order:

1. **Read protection.** The protected set's age, then every page of it.
2. **Read capacity**, when the caller names the senders that bound the run.
3. **Read candidates** from the target list. They are companies.
4. **Find the people** at each company, through enrichment (0016).
5. **Enrol each person** through the sequencer that takes the channel asked
   for (0015).

**Candidates are companies, so the path goes through enrichment.** The target
list returns accounts, and a sequencer enrols people. The path finds the
people at each account before it can enrol anyone.

**Protection fails closed, and stops the run before any enrolment.** Nobody is
enrolled, and the run is recorded as `failed` with the reason, if:

- the protected set's age cannot be read;
- its age is not a time;
- it is older than the caller allows;
- any page of it cannot be read;
- its pages loop;
- it holds an account with neither a domain nor an identifier to match
  against.

**The kernel decides what "stale" is.** The adapter reports when its data is
from (`asOf`). The caller passes `protectedMaxAgeMinutes`, which is required
and has no default. A stale answer is an inability to know, not a green light.
An adapter judging its own freshness would be grading its own homework, and
`declaredMaxLagMinutes` stays informational.

**Matching protects wide.** A company is protected if its domain, or its
identifier in the target list's own source, is a protected account's. A person
is protected if their company is, or if any address they have is on a
protected domain. Wrongly skipping someone is recoverable; contacting them is
not.

**Every skip has one stated reason**, and the reasons are kept apart:

- `protected`;
- `capacity` — no budget left on the senders the caller named;
- `duplicate` — already in the sequence, by a status read before enrolling, or
  met twice in the run;
- `unreachable` — no key the channel needs, or a lookup that failed for one
  company.

**Replaying does not enrol twice.** The idempotency key is derived from the
person, the sequence and the channel. A status read before each enrolment
reports someone already enrolled as a duplicate, not as a new enrolment.

**A provider failure mid-way stops the run where it is.** It is recorded as
`partial`, since finishing later is a replay and replays are safe. An
`invalid` or a `conflict` from the provider is a skip, not a stop.

## Why capacity is optional and still never assumed

A provider that rotates senders across a sequence's pool (0011) does not say,
per enrolment, which sender will be used. The caller knows which senders a
sequence uses. Without them the path does not check capacity, and the report
says so in words: `checked: false, why: "no sender was given"`. When senders
are given and their capacity cannot be read, the run stops before enrolling.

## Not built here

**Per-person outcomes are returned, not stored.** The run row records the
status and why the run stopped. Each person's skip reason is in the report the
path returns and the command prints. Keeping them needs a table, and a table
is its own decision.

## Rules out

- Enrolling anyone before the protected set has been read, whole and fresh.
- An adapter deciding that its own data is fresh enough.
- A skip whose reason is "not enrolled".

## Would reverse it

A protected source that can answer one account at a time faster than it can
list them all. The check would move per candidate, and stay fail-closed per
candidate. That is a change of mechanism, not of rule.
