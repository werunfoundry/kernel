# 0052 — An objection outlives the erasure, as a fingerprint and nothing else

> Completed by [0053](0053-an-enrolment-is-history-once-its-person-is-erased.md):
> the enrolment row is anonymised, not deleted, the question this decision
> left open.

> Superseded in part by [0055](0055-one-passage-reaches-a-person.md): its count
> of the reads — five, in four files, with three answers for a person not on
> record; the read in `queue` belongs to the sending run, not to drafting.
>
> Superseded in part by [0058](0058-the-registers-secrets-are-named-and-kept.md):
> an entry can be wrapped under a new secret without the key in clear; the
> rewrap on a compromise is the one other writer and the one edit the
> register admits, and an entry's version is the chain it is keyed under.

> Not built, on `main` at `350656e`: none of it — no register, no question
> at `kernel-erase`, no one reader. A live enrolment is refused once an
> erasure has run, provisionally (0055, *The threshold is held by code*).

Completes [0049](0049-erasure-reaches-a-person-by-keys-and-says-what-it-does-not.md),
which named the hole this decision closes and set the threshold it is due
by: the first live enrolment into a real sequencer, or the first real
hand-over, whichever comes first. Completes
[0041](0041-which-fact-governs-a-guard.md): the global opt-out gains a second
place it is read from.

## What was found

**The opt-out does not survive an erasure, and a test says so.**
`domains/acquisition/runtime/erasure.test.ts`, *does not let the opt-out
survive*, records a person with an address and an opt-out, erases them,
and records the same address again. It gets a new person, and the only person
on record has no opt-out. The opt-out is a column of the row erasure deletes
(`relations.person.opted_out_at`), so nothing can recognise them again. The
test does not run a sourcing or an enrolment; that the new person is
contactable follows from every contacting path reading only that column.

**On a living person, the opt-out never expires.** It has one writer,
`recordOptOut`, which sets it only when it is empty and never clears it.
Nothing else in the kernel deletes a person. An objection lasts as long as
the person is on record; only an erasure ends it.

**Four paths read it, each on its own:** enrolment, sourcing, drafting and
the message gate, each with its own query on `relations.person`. Nothing makes
them read the same thing.

## Decided

**What survives an erasure is the objection, as one fingerprint per key, and
nothing else.** When a person who had opted out is erased, each key the
erasure gathers for them (0049: their address, their networked profile id,
as `network:value`) leaves one entry in a register, `relations.suppression`:

- **the fingerprint**: a keyed hash (HMAC-SHA-256) of the key's kind,
  network and value, normalised as the identity vocabulary compares keys
  (0013). The key is a secret the instance holds, never the database;
- **the secret's version**, so that a new secret does not orphan the entries
  made under the old one;
- **when it was written**: the start of the erasure run, on the entry
  itself (below);
- **the erasure run that wrote it** (doctrine 5): attribution, set to null
  if the run is deleted. The entry depends on the run for nothing else.

No name, no company, no kind of key in clear, no date of the opt-out,
nothing from the history rows. One person leaves as many entries as keys,
unlinked to each other except through the run and the time they share.

**Why a fingerprint, and why a keyed one.** To refuse someone a later run
finds again, the register must recognise them from the address it finds.
Whatever does that can be tested against an address someone holds, which is
exactly what 0049 forbids in a history row. This is the one place where that
is the purpose. A plain hash of an address is testable by anyone holding a copy
of the database and a list of addresses, and a system that prospects holds
lists of addresses. A keyed hash is testable only with the instance's secret
as well. **It is still personal data**: pseudonymised, not anonymous,
because the instance can test it. The decision does not claim otherwise.

**What it does not allow.** The register answers one question, and only at
the moment of contact: *is this key, which the kernel holds in clear from a
source, one whose owner objected?* It cannot:

- give back an address, or say who is in it;
- be read by any path other than the opt-out check (below), so it cannot be
  counted into a metric, scored, enriched, exported or reported;
- be joined to the history 0049 left behind, whose values are derived from
  nothing;
- be tested by anyone holding a copy of the database without the secret;
- be handed to a provider's own suppression. That takes the address in clear,
  which the kernel holds again only when a source hands it back, at which point the check
  refuses the person, and suppressing them there is a later decision.

**Who gets an entry: whoever objected, not whoever was erased.** Erasure
and objection are two rights. An erasure leaves entries only for a person
whose opt-out was on record. Before it erases someone who had not opted out,
`kernel-erase` asks whether the request includes not being contacted. If it
does, the opt-out is recorded first, under the same run and at the run's
start, and the entries follow. If it does not, nothing survives, as 0049 has it. 0049's *one of the
two* becomes *both, when both were asked*.

**The question has no default.** It is asked at the terminal, like the
confirmation of the id. Only an explicit yes or an explicit no is an
answer: an empty line, a closed input, or anything else erases nothing, and
the command says so (doctrine 6). Erasing without a terminal is already
refused, and stays refused. No flag answers the question for the person typing.

**An entry does not expire.** An entry that expires guarantees that someone
who said no will one day be contacted again, which is what the register
exists to prevent. The legal basis for keeping it belongs to the instance
and its counsel, not to the kernel; so does whether a maximum duration
applies. The kernel sets none. A maximum, if one is required, can be
counted from the time on the entry, the start of the erasure run: it is never
earlier than the opt-out, which was on record before the erasure, or was
recorded by it at the run's start. For reference:
[*Comment utiliser une liste repoussoir pour respecter l'opposition à la
prospection ?*](https://www.cnil.fr/fr/comment-utiliser-une-liste-repoussoir-pour-respecter-lopposition-la-prospection-commerciale).

**A secret is not destroyed while an entry made under it lives.** A new
secret serves new entries. An old one still tests every entry written under
it, and nothing can carry those entries over to a new secret: recomputing a
fingerprint needs the key in clear, which the erasure removed. Destroying an
old secret silently cancels every protection made under it. Since entries
do not expire, an instance keeps every secret version it has used, for as
long as the register holds entries under it. Each version is part of what
the check needs: if any is missing, the check cannot answer, and fails
closed.

**Derivable by construction: the register cannot say anything the system
did not know.**

- **One writer.** Only an erasure writes an entry, in the transaction that
  deletes the keys, computed from the row it deletes: its keys, and its
  `opted_out_at`. The schema holds it: an entry names an erasure run, and the
  table is append-only. No command, API call or hand writes one.
- **No overlap with the living.** While a person exists, their row is the
  record of their objection, and they have no entry. Once erased, they have
  only entries. The two cannot disagree about anyone: no one is in both.
- **One comparison.** The fingerprint is computed from keys normalised as
  0013 compares them, by the same function the identity vocabulary uses, so
  the register cannot match differently from the rest of the kernel.
- **One reader.** The four paths that read the opt-out read it through one
  check, which answers from `opted_out_at` for a person on record and from
  the register for the keys in hand. No path reads either alone.
- **Fails closed** (doctrine 6). If a secret version the register uses is
  missing, or the register cannot be read, the check cannot answer, and
  every path that contacts stops. A register nobody can read protects
  nobody, and must not look as if it did.

## What the commands say they do not reach

- **An objection the kernel never observed.** One made at a provider and not
  yet pulled (0039, 0051's verb 4) is not on the row erasure deletes, and
  leaves no entry. Erasure says so on its plan.
- **A key the person did not have on record.** An address found later that
  was never theirs in the kernel matches nothing.
- **A key shared with others**, such as a generic address, suppresses everyone
  found through it. 0049's gathering already reaches by shared keys; here it
  errs on the side of not contacting, and the plan shows it.
- **A secret version destroyed anyway.** Its entries can no longer be tested.
  Every path that contacts stops until it is restored. If it never is, the
  entries are worthless, and the plan of every later erasure says the
  protection they gave is gone, and for how many entries.
- **Backups, logs and working copies**, as 0049 lists them.

## Rules out

- An entry for a person who was erased without objecting.
- An erasure on any answer to the question but an explicit yes or no.
- An unkeyed or reversible fingerprint; a secret kept in the database.
- Any field in the register beyond the fingerprint, the secret's version,
  the time it was written and the run.
- A writer other than the erasure; an edit to an entry.
- A path that reads the opt-out, or the register, on its own.
- An entry that expires by default.
- A secret version destroyed while an entry made under it lives.
- A check that answers "not suppressed" when it could not read.

## Would reverse it

A way to recognise a person that cannot be tested against their address. No
such way exists: recognising and testing are the same act. Short of that,
a counsel who requires a different form, or a maximum duration. A maximum
can be honoured as the register stands, counted from the time on the entry;
it needs only a decision that sets it and says why.

## Not decided here

- **`do: delete` or `anonymise` on the enrolment registry's row** (0051).
  It follows from this decision, now that what may survive is known.
- **Suppressing the person at the provider** when a source hands them back.
- **A person who withdraws an objection** after their erasure. The kernel no
  longer knows who they are. Their new consent is a new person's, and lifting
  an entry would need their address, given by them.
- **The shape of the secret's rotation**, and of the register's schema.
  That old versions are kept is decided above.
