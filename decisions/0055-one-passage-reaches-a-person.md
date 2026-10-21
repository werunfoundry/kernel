# 0055 — One passage reaches a person

Completes [0050](0050-the-sending-path-end-to-end-with-its-hand-over-stubbed.md),
whose first defect said that a single gate would have to close the
enrolment's bypass; and [0052](0052-an-objection-outlives-the-erasure-as-a-fingerprint.md),
whose one reader this places. Supersedes in part 0052, its count of the
reads, and [0049](0049-erasure-reaches-a-person-by-keys-and-says-what-it-does-not.md),
its threshold.

## What was found

On `main` at `fc93058`, and on the open pull request #94 at `9cd354a`.

- **Two places reach a person, and nothing makes them the only two.** The
  enrolment calls the sequencer's `enrol` (`enrol.ts:533`). The sending
  path calls its hand-over (`send.ts:335`).
- **The opt-out is read five times, in four files, with three answers for a
  person not on record.**
  - Enrolment (`enrol.ts:441`) and sourcing (`source.ts:569`) do not ask.
  - `propose` (`draft.ts:122`) and the message gate (`message.ts:75`)
    refuse.
  - `queue` (`draft.ts:260`) drops the draft as "opted out". That branch
    cannot run: `draft.person_id` is not null and restricts deletion, and
    against a database both ways to reach it are refused.
- **The threshold 0049 and 0052 rest on is held by one absent field.** The
  sequencer adapter this repository ships declares nothing, so the kernel
  will not enrol through it. #94 adds the declaration; run, it answers that
  it can suspend. Nothing of 0052 is built.
- **A dry run answers before the gate.** Run, it says `would_propose` and
  `would_send` where the live run refuses on consent and on the cap.

## Decided

### 1. One passage

**Reaching is two steps, `clear` and `reach`.** `reach` is the only code in
the kernel that calls a contact verb: the sequencer's `enrol`, the
hand-over, and any verb added later that delivers something to a person.

**It takes a clearance, which only `clear` produces.** A clearance is for
one person, by the keys in hand; one channel; one target; one run; and one
use. Its type lets nothing outside the passage build one. `reach` also
refuses, at run time, a clearance it did not issue or has already used,
because code the compiler never saw can build anything of the right shape.

**`clear` evaluates three things:**

- the threshold (section 4);
- the objection (section 3);
- protection, read once per run, fresh and failing closed, moved unchanged
  from `readProtection` (0004, 0019, 0044).

**A stop is not a contact.** Withdrawal, suppression and suspension never
pass through `clear`.

**The passage lives in `acquisition`; the reader lives in `relations`**,
each with the fact it owns.

**Doctrine 6 gains one line**: *nothing reaches a person except through the
one passage.* Two checks name it:

- **`check.mjs`** fails a contact verb called outside the passage, and the
  opt-out or the register read outside the reader, its writer, erasure and
  the schema.
- **`check-instance.mjs`** fails an adapter that imports the passage or the
  reader. It is the only check that reads an instance; `check.mjs` never
  does.

Both are tripwires on text, and a computed call passes them. What holds is
the type and the run-time refusal.

### 2. Why cadence and lane are not in `clear`

**Cadence.**
- *Why not.* The cap counts touches (0050). At enrolment the count can be
  computed — it is one query — but it would be wrong in a known direction.
  Nothing records what a sequencer sends on its own, because 0051's verb 2,
  the touches pull, is not built. The count misses exactly the sends a
  running sequence makes, and so errs toward letting through. A guard that
  reads as a cadence check while it does that is doctrine 6's source that
  answers cheerfully with last week's rows.
- *Why not even with a complete count.* A count judges the window behind.
  An enrolment commits to steps whose number and spacing live at the
  provider, and the contract does not describe them (`sequencer.ts:4-8`).
- *What fills it.* The touches pull, for a complete count; and the steps
  known to the kernel, for a cap judged ahead.

**Lane.**
- *Why not.* An enrolment names no experiment (`enrol.ts:533-541` passes
  only the run) and carries no message to approve. There is nothing for a
  lane to judge.
- *What fills it.* An enrolment that belongs to an experiment, with steps
  the kernel holds.

Until those exist, enrolment is neither capped nor approved, and says so.
At the hand-over, both stay the message gate's (0038, 0050).

### 3. One reader of the objection

**One function answers whether a person objected, from the keys in hand.**
It reads `opted_out_at` for the person on record, and the register (0052)
for the keys. Every read goes through it. Sourcing's and drafting's reads
spare a payment or a draft. They never stand in for the passage's.

**It has three answers: objected, no objection on record, cannot answer.**

- **Keys that name no recorded person and match no entry: no objection on
  record.**
  - *Not "unasked"*: an erased objector found again is never on record,
    which is the very case the register exists for.
  - *Not "objected"*: the kernel can honour only the objections it
    observed. Treating everyone it never saw as objecting refuses every
    first contact, and writes as a person's act what nobody observed.
- **An id that names no row: cannot answer.** There are no keys to ask the
  register with. It is refused for that reason, and never recorded as an
  objection. `queue`'s dead branch goes.
- **The record or the register unreadable, or a secret version missing:
  cannot answer**, and the run stops (0052).

The person on record is found by every key in hand, as `findPerson` has
done since `fc93058`. The reader inherits that lookup and does not
redecide it.

### 4. The threshold is held by code

**The threshold is the first live contact through the passage.** `clear`
refuses every live contact unless the reader answers from both the record
and the register: the register exists, and every secret version is
present.

**One adapter is spared: the kernel's own sandbox sequencer, recognised by
provenance.** The resolver turns a binding into a module. When that module
is the sandbox inside the kernel's installed package, a contact may proceed
on the record alone while the register cannot be read, and the run says
so. What spares it is the module the kernel resolved — never a
declaration, never a name.

**Today it cannot be recognised, so the sandbox moves with the passage.**
- `new-instance` copies `template/` (`scripts/new-instance.mjs:35`). The
  sandbox becomes `./adapters/sandbox-sequencer.ts`, bound by relative path
  (`template/manifest.yaml:53-54`).
- A relative path is a file of the instance (`core/runtime/resolve.ts:106-112`),
  and the template invites the instance to replace it
  (`manifest.yaml:28`). A file the instance owns and may change is the
  instance's adapter.
- So the sandbox sequencer ships in the kernel's adapters package, and the
  template binds it by package name. `check.mjs` refuses a network call in
  it.

**What the exemption guards against, and what it does not.** It guards
against a sentence. It does not guard against someone patching the kernel's
installed code: that is changing the kernel.

**Until the passage exists, a provisional guard holds the line** (#97).
`kernel-enrol` refuses `--live` once an erasure run is on record.

- *What it reads.* One row of `core.run` whose `process_key` is
  `relations.person.erase` and whose `dry_run` is false
  (`acquisition/bin/enrol.ts:103-107` in #97).
- *What it does on a match.* It returns before any run is opened and
  before the enrolment is called.
- *How it ends.* #94's declaration merges behind it. It is removed in the
  change that brings `clear`'s threshold, and never before.

**What the provisional guard holds.**
- *The hazard, not the threshold as 0049 wrote it.* 0049 put the threshold
  where an erased objector could be found again and recontacted. Before
  any erasure there is no such person; from the first erasure on, the
  guard refuses.
- *What it lets through.* A live enrolment into a real provider is allowed
  until the first erasure, so 0049's literal threshold is crossed. The
  other gaps this decision closes stay open while the guard stands.

**What the provisional guard does not reach.**
- *A deletion outside `kernel-erase`*, which opens no run of that
  process.
- *An erasure run deleted by hand.* `core.run` is not append-only, and the
  guard says itself that such a deletion reopens the window.
- *A caller of the enrolment's runtime.* The guard is in the command, not
  in `enrol`. Today only the tests call `enrol` without the command.
- *The hand-over*, which no command calls.

**What it refuses too broadly.**
- It refuses every live enrolment once one erasure run is on record,
  whoever was erased and whether they objected.
- It reads neither the run's status nor what it erased, so a failed
  erasure counts too.

Both err on the side of refusing.

**The CI keeps its live path, and exercises the refusal.** `try-instance`
runs every live enrolment before its erasure. In #97 it then asks for one
more, after the erasure (`try-instance.mjs:453`).
- *What it expects.* `--live` is refused with the guard's reason; the
  refusal opens no run; a dry run still reads.
- *Counter-checked.* With the guard removed and the step kept, run,
  `try-instance` fails at that step.
- *What it exercises.* The refusal, not the harm. Unguarded, that live run
  enrolled nobody, because the sandbox's state file still holds the erased
  person and the run skipped them as a duplicate.

### 5. A dry run answers what the gate answers

**A dry run goes through the same `clear` and, for a send, the same message
gate, writing nothing.** It stops at the first write and gives the gate's
own reasons.

**What it does not see:**

- **its own writes.** A cap the live run would reach within that run is
  not reached by its dry run, and the report says so;
- **the provider's side.** That the provider writes nothing rests on the
  adapter, as for every contract (`core/contracts/types.ts:29`).

## Correcting 0052's count

There are **five reads, in four files**, not four paths. `draft.ts` is read
twice. **The read in `queue` belongs to the sending run** (`send.ts:327`),
not to drafting. There are three answers for a person not on record, and
one of them cannot run.

## What the passage removes, and what stays

- **Removed:**
  - a dry run announcing what the live run refuses;
  - a third path to a person, or a sixth read of the objection, as far as
    the type, the refusal and the checks see.
- **Already gone, before the passage:** a recorded person found by their
  first address only, fixed on `main` by `fc93058`. Run, an opted-out
  person whose recorded address comes second is now skipped. On `b56e19b`
  they were enrolled.
- **Stays:**
  - the composer receiving the address of someone who objected — composing
    reaches nobody;
  - a person with no recorded company and no address, cleared by
    protection, which moves unchanged;
  - sourcing paying before it reads the objection.

## What this does not reach

- **The window between `clear` and `reach`.** The enrolment holds no lock
  between its read and its call (`enrol.ts:441`, `:533`). The send commits
  `queue` before it hands over (`send.ts:327`, `:335`).
- **The steps a sequencer sends after enrolment.** An objection made after
  enrolment is honoured only by a suspension, and nothing calls one (0051).
- **Which company protection judges** (0041 against 0050).
- **An instance adapter that reaches someone through a contract that is not
  for contact**, or through its provider's own automation.
- **Established by reading, not by running:**
  - the two windows above;
  - that #94's adapter parks and reads back as it says;
  - that moving the sandbox keeps `try-instance` green.

## Rules out

- A contact verb called outside the passage.
- A read of the objection outside the one reader.
- A person the kernel cannot find recorded as objecting, or one it never saw
  treated as objecting.
- A threshold held by a missing declaration.
- A live contact while the register cannot be read, except through the
  kernel's own sandbox recognised by provenance.
- A dry run whose answer differs from the gate's.
- A cadence check computed from a count known to be incomplete.

## Would reverse it

- **A property the kernel can establish about any adapter** that it reaches
  nobody. The exemption could then widen beyond the kernel's own sandbox.
- **A kernel that never calls a provider to reach anyone.** The passage
  would have nothing to guard.

## Not decided here

- **The shapes** of the clearance, of the passage and of the reader.
- **The open findings:** the composer; a person cleared with nothing to
  match; sourcing's order.
- **The missing pointers:** 0041 to 0050, and 0004 to 0051.
