# 0062 — The register is written by its domain, inside the erasure's transaction

Completes [0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md),
whose one writer is "an erasure … in the transaction that deletes the keys"
and which says nothing of how a domain's table is written there; and
[0058](0058-the-registers-secrets-are-named-and-kept.md), whose versions
nothing hands to that writer. Rests on
[0056](0056-erasure-stops-the-person-before-it-forgets-them.md), whose step
runs before the transaction and whose loading this reuses.

## What was found

On `main` at `d47d172`.

- **The core cannot write the register.** `erase()` in
  `core/runtime/erase.ts` carries out the domains' rules in one transaction:
  delete, anonymise, keep (0040). None of them writes a row. The core names
  no domain and no column (doctrine 1, 2), so it can read neither
  `relations.person.opted_out_at` nor `relations.suppression`.
- **0056's step cannot either.** It runs before the transaction opens. An
  entry it wrote would commit even if the deletion rolled back, and the
  keys it is given are gathered before the transaction gathers them again
  (`subjectKeys`).
- **Nothing carries 0052's answer to the erasure.** `kernel-erase` asks
  the question, in `relations`. `erase()` opens the run under which 0052
  records the opt-out. Nothing passes the answer from one to the other.
- **The writer is late in a way the reader is not.** Each erasure of an
  objector that happens before the register exists loses their entry for
  good: the keys are deleted, and nothing can compute a fingerprint
  afterwards. A missing reader, by contrast, delays protection without
  destroying any.

## Decided

**A domain may declare a step that runs inside the erasure's
transaction.** It is called `duringErasure` in its `domain.yaml` and names
an export of its own package, as `beforeErasure` does (0056). The core
loads it the same way and never imports a domain.

- **When.** After every step before erasure has finished, and after the
  transaction has gathered the subject's keys. Before any rule.
- **What it is given.**
  - the transaction;
  - the subject;
  - the keys the transaction gathered;
  - the run, with its id and when it started;
  - whether the request includes an objection (below);
  - a function that fingerprints a key under the version that writes (0058).
- **What it is not given.** No secret: the function holds it. No bound
  adapter: a provider is never called inside the transaction (0056, *Rules
  out*).
- **It fails closed.** If the step throws, the transaction rolls back,
  nothing is erased, and the run ends failed.

**The objection travels with the request, and has no default.** `erase()`
takes from its caller whether the request includes not being contacted,
true or false, and refuses an erasure whose caller says neither. The core
names the right, as it already names erasure. It does not name what a domain
does with it. `kernel-erase` asks the question for anyone not already opted
out (0052, *The question has no default*). Relations' step then:

- records the opt-out at the run's start, if one was asked for and none is
  on record;
- writes one entry per gathered key, if an opt-out is on record;
- writes nothing otherwise.

**One fingerprint function, in the core, with a fixed encoding.** It is the
mechanism 0058 named, and the reader 0055 places will call the same function.
- *A key.* It is normalised as 0013 compares keys (`normalizeIdentity`). Its
  kind, network (empty when it has none) and value are joined by NUL and
  encoded as UTF-8. The fingerprint is HMAC-SHA-256 of that under the
  version's secret.
- *A wrapped entry.* The fingerprint is HMAC-SHA-256 of the previous
  fingerprint's 32 bytes under the next version (0058, §3).
- *The check value.* It is HMAC-SHA-256 of a fixed sentence that contains no
  NUL, so it can never equal a key's fingerprint (0058, §1).
- *Stored as 64 lower-case hexadecimal characters.*

**The encoding never changes while an entry lives.** If it changes, every
entry stops matching, as surely as if its secret had been destroyed (0052).
So the entries written before the reader exists will be readable the day it
arrives: it computes the same thing from the keys a source hands back.

**Boot hands the versions to the erasure.** Boot checks them (0058, §1) and
returns them. The erasure passes the writing one to the step as the function
above. If a domain declares a step inside the transaction and the erasure was
given no versions, the erasure is refused, as an erasure without bound
adapters already is (0056).

## Not built yet

On `main` at `d47d172`: none of it, nor anything of 0052 and 0058.

## Rules out

- The core naming the register's table, or the column it reads.
- An entry written outside the transaction that deletes the keys.
- A step inside the transaction that is handed a secret, or a bound adapter.
- An erasure whose caller does not say whether the request includes an
  objection.
- A second fingerprint function, or a change to the encoding while an entry
  lives.

## Would reverse it

**A second domain that writes fingerprints at erasure.** A declarative rule
was weighed instead of a step: "for each key, write a fingerprint into this
table when this column holds a value". It would put the register's shape
into the core's vocabulary for the sake of a single user, and the
condition, the columns and the question would each need a form of their own.
Once a second domain needs the same write, the form is worth having, and
that write moves down into the rules.

## Not decided here

- **The reader** (0055, §3). It answers from the register once it exists;
  until then, the register is written and read by nobody. 0055's
  provisional guard stands meanwhile.
- **The rewrap command and the command that generates a version**: their
  names, and the rewrap's process key (0058, *Not decided here*).
