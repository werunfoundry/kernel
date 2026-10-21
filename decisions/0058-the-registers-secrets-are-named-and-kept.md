# 0058 — The register's secrets are named, checked, and rewrapped only on compromise

> Completed by [0062](0062-the-register-is-written-by-its-domain-inside-the-erasure.md):
> boot hands the versions to the erasure, and one function in the core
> fingerprints under them, with an encoding that never changes.

> Not built, on `main` at `350656e`: none of it — no `fingerprints` section,
> no check at boot, no command that generates a version, no rewrap. Nothing
> depends on it yet: 0052's register is not built.

Completes [0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md),
which left "the shape of the secret's rotation" undecided. Supersedes 0052
in part, on four points (below). Changes what an instance holds, which is
why it is a decision and the register's schema is not.

## What was found

**The register says which versions it needs. Nothing says under which name
the instance holds them, or which one writes.**
- 0052 defines a missing version against the register itself: "a secret
  version the register uses" (0052, *Decided*). The entries name their
  versions, so the set that must be present is already known.
- What is not known is where the secret for a version is found: no rule
  ties a version to a variable. Nor which version a new entry is written
  under.
- Boot cannot read the register: it touches no database
  (`core/runtime/boot.ts:6` at `a78b7f8`).

**What an instance holds today.**
- *The engine's variables.* Their names are fixed in code (`DATABASE_URL`,
  `DIRECT_URL`, `KERNEL_API_TOKEN`), and each command reads them itself.
- *An adapter's variables.* Their names are chosen in a binding's `env`,
  and only that subset is handed to the adapter.
- *Nothing versioned.* No secret has versions, no variable holds a list,
  and nothing rotates.
- *Nothing stored depends on a secret's value.* The API's token can be
  replaced at will. The register's secret would be the first whose loss
  destroys a protection already written, and whose old values must stay
  present for good.

**Run, with HMAC-SHA-256 and invented secrets:**
- *An entry can be carried over to a new secret without the key in clear.*
  Wrapping the stored fingerprint, `HMAC(k2, entry)`, needs only the entry
  and `k2`. The check, holding the key from a source, computes
  `HMAC(k2, HMAC(k1, key))` and finds it. 0052, *Decided*, says nothing can
  carry them over; that is wrong.
- *What wrapping protects.* A copy of the database taken after the wrap
  cannot be tested with `k1` alone. A copy taken before it still can.
- *Wrapping does not merge versions.* A `v1` entry wrapped under `v2`
  differs from the same key written directly under `v2`, so the check does
  not get cheaper: it still computes one value per chain of versions in
  use.
- *The right name with the wrong value fails open, silently.* Under
  another value, the check no longer finds the entry, answers "no
  objection on record" (0055), and the person is contacted. A check value —
  `HMAC(secret, a fixed constant)`, kept beside the version's label —
  differs at once.
- *A published check value makes a chosen secret guessable offline.* The
  constant is in the code. Anyone holding the instance's repository can
  compute `HMAC(candidate, constant)` and compare: about 350,000 candidates
  a second on one core, with no database, no network and no rate limit.
  `password123password123password12` is 32 characters long, and a list of
  candidates finds it.

## Decided

### 1. The instance names its versions in its manifest

**The manifest gains a `fingerprints` section**: each version's label, its
check value, the reason it was added, and which version writes.
- *Why the manifest, not the environment.* The list is configuration, not a
  secret. The manifest is committed in the instance, so its history records
  when each version was added. The check value could sit beside the secret
  in the environment instead: nothing would be published, and the same
  error would be caught. But that history would be lost, and a generated
  secret makes publishing the check value safe (below).
- *Why "fingerprints".* The core names the mechanism, not the business
  (doctrine 1). `relations` is its one user today.

**A version's secret lives in `KERNEL_FINGERPRINT_<LABEL>`**, a name the
kernel derives from the label and the instance never chooses.
- A label is upper-case letters and digits.
- It is written into entries, so it is never renamed, never reused, and
  never removed while an entry names it.

**A secret is generated, never chosen, and that is what makes its check
value publishable.**
- *What a secret is.* 32 random bytes from the operating system's
  cryptographic generator, written as 64 hexadecimal characters.
- *Who makes it.* The kernel ships the command that generates a version.
  It prints the variable's line for the environment, and the label, check
  value and reason for the manifest.
- *Why that makes publishing safe.* Against 2^256 possible secrets, a
  published check value tests nothing.
- *The check value's constant.* No key the identity vocabulary normalises
  can equal it, so a check value is never an entry's fingerprint.

**Boot refuses, before anything runs:**
- a declared version whose variable is not set, or is not exactly 64
  hexadecimal characters;
- a variable whose value does not reproduce its version's check value;
- a declared version without a reason;
- no version that writes, or one that writes without being declared.

Boot cannot see the register, so this is everything it can know. At
contact, the one reader (0055) adds what boot cannot: every version an
entry names must be declared, or it cannot answer.

### 2. Parallel versions, and a version a person adds

**New entries are written under the version that writes. Old entries stay
under theirs. Nothing is rewritten**, and 0052's append-only table holds in
normal operation.

**A check computes one fingerprint per chain of versions the register uses,
and compares each.**
- Each one costs microseconds; a hundred are nothing.
- What bounds the set is how often versions are added.

**A version is added by a person, with its reason. The kernel never adds
one by itself.**
- *What the kernel expects.* A compromise. In parallel, a rotation retires
  nothing: every old version stays required, so a rotation that answers no
  compromise only grows the set and splits exposure.
- *What it does not forbid.* Any other reason a person records, a calendar
  included — say, counsel's "every quarter". Each adds one version and one
  fingerprint to every check, microseconds a year.
- *What it forbids.* A version that appears with no reason on record, and a
  rotation the kernel runs on its own.

### 3. Rewrapping, once, on a compromise, recorded as such

**When a version is compromised, every entry whose chain names it gains one
layer under a new version that writes.** A person runs it at a terminal
(0047), naming the compromised version. It runs:

- once per compromised version;
- in one transaction;
- as a run of its own process, which records the compromised version, the
  new one, and how many entries it wrapped.

**An entry keeps its time and its erasure run.** Its chain of labels says it
was wrapped, and under what.

**The schema admits this one rewrite, and only it.**
- What may change: the fingerprint, and the chain, which may grow by
  exactly one label at its end.
- What may not: anything else.
- Every other update stays refused, and every delete.

Append-only remains the rule. This is its one exception, named rather than
dissolved.

### 4. What this replaces in 0052

| 0052 | Now |
| ---- | --- |
| "nothing can carry those entries over to a new secret" (*Decided*) | they can be wrapped under one, without the key; it protects later copies only |
| "Only an erasure writes an entry … the table is append-only" (*Decided*) | the erasure writes an entry; the rewrap is the one other writer, and only on a compromise |
| Rules out "a writer other than the erasure; an edit to an entry" (*Rules out*) | rules out any edit but the rewrap's |
| "the secret's version" (*Decided*) | the chain of versions the entry is keyed under, oldest first; one label for every entry never wrapped |

The register still holds four fields (0052, *Rules out*). The fourth means a chain
now.

## What this does not reach

- **Copies already taken.** A copy of the database taken before a rewrap —
  a backup, a dump, a replica, a working copy — stays testable with the
  compromised secret, whatever is done afterwards. The probe showed it.
  Backups expire on the instance's retention (0049); until then, a leaked
  secret and an old backup together name who objected.
- **A leak nobody notices.** No rewrap runs, and nothing in the kernel can
  tell.
- **The compromised secret itself.** It stays required for good: a wrapped
  entry needs every secret in its chain. Destroying it still cancels every
  protection made under it (0052).
- **The cost of the check.** A rewrap does not lower it: a wrapped entry
  and a native one are two chains.
- **The instance's repository becomes a target it was not.** The manifest
  publishes, for each version, what it takes to test a candidate secret
  offline. Against a generated secret that is nothing.
- **A chosen secret that passes for a generated one.** Boot checks the
  form, 64 hexadecimal characters, not where they came from. A person who
  types them, or derives them from a password, makes a secret the published
  check value lets anyone guess, and boot cannot tell.

## Rules out

- A version's secret under a name the kernel does not derive from its
  label.
- A list of versions held outside the manifest.
- A label renamed, reused or removed while an entry names it.
- A secret that does not reproduce its version's check value.
- A secret chosen by a person rather than generated; a secret that is not
  32 bytes.
- A version declared without its reason; a version the kernel adds by
  itself.
- A rewrap without a declared compromise, a second rewrap for the same
  one, or a rewrap that changes anything but the fingerprint and the end of
  the chain.
- An entry written under a version that does not write.

## Would reverse it

- **For parallel versions:** a scheme in which a new secret replaces an old
  one for every copy, the old ones included. None exists: a copy already
  taken keeps what it has.
- **For a version added only by a person:** evidence that versions leak
  silently and routinely. A rotation the kernel runs on its own would then
  be worth its growing set.
- **For a published check value:** a check value that must be kept from
  the instance's repository. It would then move beside the secret in the
  environment, and its history with it.
- **For the rewrap:** copies of the database that are all taken before any
  compromise could be noticed — every copy a backup, say. Then a rewrap
  protects nothing that leaks, and parallel versions alone would do.

## Not decided here

- **The register's schema**, within 0052 and the four points above.
- **The names of the two commands** — the one that generates a version, and
  the rewrap — and the rewrap's process key.
- **How a person chooses a label.**
