# 0026 — The enrolment registry

Completes [0019](0019-the-enrolment-path.md), whose outcomes were returned
and printed, not stored, and [0013](0013-an-identity-is-a-set-of-keys.md),
whose identities had nowhere to be recorded.

## Decided

**`gtm.enrolment`, one row per person per sequence**, unique in the DDL. It
holds the person, the company they were enrolled through, the sequence and
channel, the idempotency key the provider was given, the adapter, and the
registry's own state: `pending`, `enrolled`, `refused`. Attributed to the run
that last wrote it (doctrine 5).

**Written before the provider is called.** For each person: the registry is
read; a person it has enrolled in the sequence is a duplicate without asking
the provider. Otherwise a `pending` row is written, the provider is called
with the key on record, and the row is settled. A run that dies in between
leaves it `pending`; the next run asks the provider, and enrolled there means
confirmed here — counted as reconciled, never enrolled twice. A replay uses
the stored key even when the person's keys have grown since.

**`gtm.enrolment_skip`, every candidate not enrolled**, per run, with its
reason — protected, capacity, duplicate, unreachable, as four values of one
enum — and the subject as it was seen, unique per run and subject. Kept for a
dry run too. It names no relations row: a protected person is not recorded
as a person in order to record that they were not contacted.

**A dry run writes its run and its skips, nothing else.** No registry row, no
person, no company. It reads the registry, so it predicts duplicates the way
the live run will.

**People and companies are written by relations, never by gtm** (doctrine 2):
`recordPerson`, `recordCompany` and `recordTouch` in
`relations/runtime/record.ts`. A person is found by its profile id on a
network first, then by address; a company by its id on a network, then by
domain. Two rows that each match one key, or a row whose immutable key differs
from the identity's, is a conflict (0013) — the person is skipped as
unreachable, nothing is merged. Recording fills an empty column and never
overwrites one.

**`relations.touch` gains attribution and becomes append-only in the
schema.** It already existed — both directions, the provider and its event id
unique in the DDL — with no run, no actor, and append-only as a comment. A
trigger now refuses every UPDATE except the one the schema makes itself: a
deleted run or experiment setting its reference to null.

## Why

"Is this person already enrolled, and where" was answered by asking each
provider in turn, which the protection that comes next (withdrawing people
from a company that became protected) cannot do: it needs the people at a
company, across sequences, and a provider answers about one person in one
sequence. And a run that died after the provider acted, before anything was
recorded, could only be found by asking every provider about everyone.

## What it deliberately does not do

- **The step a person is on is not stored.** It is the provider's fact and
  changes without the engine; it is read from the provider with the registry's
  reference (doctrine 3). The registry answers "enrolled, in which sequence,
  through which company"; "at which step" is one status call away.
- **The enrolment path writes no touch.** Enrolling sends nothing; a touch is
  an interaction that happened. Its first writer is the inbound loop.
- **No DELETE guard on touches.** Erasure, when it comes, deletes; the restrict
  on `person` already stops a casual delete.
- **No experiment on an enrolment.** The sequence is what the path enrols
  into today; the experiment arrives when experiments replace campaigns.

## Rules out

- Asking a provider what the registry knows.
- A second enrolment under a new key for a person a crashed run left pending.
- A domain other than relations writing `person`, `company` or `touch`.
- Rewriting a touch.

## Would reverse it

A provider that cannot be asked whether an enrolment landed — no status by
person and sequence. Then `pending` cannot be reconciled, and the registry
would need the provider's own enrolment id, written back before the call
returns, which only a provider that accepts the caller's id can do.
