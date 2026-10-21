# 0063 — A lost secret stops contact, not erasure

Supersedes in part [0058](0058-the-registers-secrets-are-named-and-kept.md):
boot no longer refuses an old version whose variable is not set, only the
version that writes. Completes
[0062](0062-the-register-is-written-by-its-domain-inside-the-erasure.md),
whose erasure is given the version that writes and no other. Rests on
[0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md), whose
outcome for a destroyed secret this restores.

## What was found

On `main` at `d1ce41f`.

- **0058 refuses at boot, for every process.** "Boot refuses, before
  anything runs: a declared version whose variable is not set" (0058, §1).
  Its scope is unrestricted, and it says why: "Boot cannot see the register,
  so this is everything it can know."
- **A label is never removed while an entry names it** (0058, §1). A lost
  old secret therefore stays declared for good.
- **`kernel-erase` boots** (`domains/relations/bin/erase.ts`, `main`).
  Together, the two rules mean that once a secret is lost, no one can be
  erased again, whoever they are.
- **0052 expected the opposite**, and 0058 does not supersede it there. "A
  secret version destroyed anyway … Every path that contacts stops until it
  is restored. If it never is, the entries are worthless, and the plan of
  every later erasure says the protection they gave is gone, and for how
  many entries" (0052, *What the commands say they do not reach*). Later
  erasures run. 0058's table of what it replaces in 0052 (§4) does not list
  this sentence.
- **An erasure needs one version.** It deletes keys and writes entries
  under the version that writes (0062). It reads no entry, so a missing old
  version takes nothing from it.

## Decided

**A missing variable is refused where it is needed, and no earlier.**

| A declared version | At boot | At erasure | At contact (0055) |
| --- | --- | --- | --- |
| the one that writes, unset | refused, for every process | — | — |
| another, unset | a warning naming it | goes on; the plan counts its entries | cannot answer: the run stops |
| any, set but malformed or not reproducing its check value | refused, for every process | — | — |

- **The version that writes is still required at boot.** Without it, an
  erasure cannot write its entries, and a process that started anyway would
  find that out only when someone is erased. A lost writing secret is
  replaced by adding a new version that writes, with its reason (0058, §2).
  The lost one then becomes an old version, unset, and the row above
  applies to it.
- **A wrong value is still refused everywhere.** It is a mistake rather
  than a loss, and it fails open in silence (0058, *What was found*).
  Unsetting it turns it into a missing version, which is honest about what
  the instance holds.
- **Erasure goes on, and says what is gone.** Its plan counts, for each
  missing version, the entries whose chain names it. They protect nobody
  from then on, as 0052 has it. Reading that count is erasure's, which 0055
  allows to read the register.
- **Contact stops.** The one reader cannot answer while a version that some
  entry names is missing (0052, *Decided*, *Fails closed*; 0055, §3). Until
  the reader exists, nothing reads the register, and 0055's provisional
  guard refuses every live enrolment once an erasure has run.

## Rules out

- An erasure refused because a version other than the one that writes is
  missing.
- A missing version that passes in silence: boot warns, and every erasure
  plan counts its entries.
- A process that boots without the version that writes.
- A set variable with a wrong value accepted anywhere.

## Would reverse it

**An erasure that has to read entries**, for example to avoid writing a
duplicate of one made under another version. It would then need every
version, and a lost one would stop it again. Nothing in 0052, 0058 or 0062
reads before writing: an entry is written once, by the erasure of the
person it came from.

## Not decided here

- **Whether contact ever resumes after a version is lost for good.** 0052
  stops it "until it is restored" and goes no further.
