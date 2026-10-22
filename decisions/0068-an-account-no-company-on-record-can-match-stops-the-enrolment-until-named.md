# 0068 — An account no company on record can match stops the enrolment until it is named

Supersedes in part [0019](0019-the-enrolment-path.md), its steps 3 and 4:
the enrolment reads no candidates and finds no people; it takes them from
a sealed list. Supersedes [0032](0032-enrolment-reads-what-sourcing-kept.md):
an enrolment no longer reads a sourcing run. What a run kept reaches a
person through a list, drafts and their approval, and the operator's gate
it kept stays: a person constitutes the list. Completes
[0034](0034-an-uncovered-customer-is-acknowledged-by-a-person.md), whose
acknowledgement names a customer, with one that names an account; and
[0057](0057-a-newly-protected-account-is-stopped-when-a-run-looks.md),
whose stop does not reach such an account and now says so. Rests on
[0044](0044-protection-matches-a-domains-ancestors-and-fails-closed.md),
which fails closed on an account nothing can be matched against, and on
[0064](0064-one-verb-reaches-a-person-and-carries-the-message.md), whose
section 1 left the list as the only way to a person.

## What was found

- **The target list's own identifier matches only a candidate.**
  `readProtection`'s `judge` compares a protected account's `externalId`
  with a company's `externalId`, which a candidate of the target list
  carries. A company recorded in `relations` carries its domain and its
  company id on a network, not that identifier (`recordedCompany` in
  `enrol.ts`, `asCandidate` in `protected.ts`).
- **Every company the enrolment judges is recorded.** Since 0064 §1 the
  enrolment takes its people from a list, so a protected account known by
  that identifier alone protects nobody on it. The same holds for the stop
  of what runs (0057), which reads the registry; its *Built by #113* note
  already said so.
- **The rows concerned cannot be designated.** Which of a list's people
  work at such an account is exactly what nothing here can say.

## Decided

### 1. The enrolment stops, after the stop of what runs

A protected account whose only key is the target list's own identifier — no
domain, no company id on a network, on any row that carries that identifier
— stops the enrolment run, naming it, and nobody is enrolled. Not one
person: the people it would concern cannot be told apart, so the hole is
the whole run.

The stop of what already runs (0057) acts first: a run that reaches nobody
new still withdraws what it can.

### 2. A person names each account, and only by its name

The run goes on past an account a person acknowledged as unmatched, by its
identifier, with a reason, through `kernel-acknowledge --account`, in a
run of its own (0034's form). Every run then says which acknowledged
accounts it could protect nobody at.

**There is no acknowledgement of all of them, or of any still to come.** A
new account of this form stops the run again until it is named; a
withdrawn acknowledgement stops it again. An escape that covered the next
one would be the hole under another name.

### 3. The twin, on the stop of what runs

The stop (0057) cannot find an enrolment at such an account either. It
does not refuse: refusing would withdraw nobody else. It names each one it
did not reach, at every run and in `kernel-stop-protected`, so that the
limit is read where the promise is.

**What that leaves.** A person enrolled before their account became
protected, at an account known by the target list's own identifier alone,
keeps receiving the steps of their sequence. Nothing here stops them; a
person who knows can stop them at the provider, and attest it with
`kernel-attest-stop`.

### 4. Sourcing is unchanged

Sourcing judges the target list's own candidates, which carry the
identifier, and matches the account as before.

## Rules out

- Copying the target list's identifier into `relations`: a fact this
  system does not own is read, never copied.
- An acknowledgement that covers what it does not name.
- Enrolling past an account that may protect someone on the list.
- The stop of what runs refusing for what it cannot reach.

## Would reverse it

- **A target list that keys every protected row by a domain or a company
  id on a network.** Nothing would be known by its identifier alone.
- **A way to read, for a recorded company, its identifier in the target
  list**, from the target list itself, at the time of the run. Protection
  could then match it, and section 1 would refuse nothing.
