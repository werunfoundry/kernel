# 0059 — A decision cites what does not move, and says what it has not built

Changes the conventions of this folder, written in
[`README.md`](README.md), and the line of `CLAUDE.md` that restated them. It
supersedes no decision: it decides how decisions are written, and how a
merged one may be corrected.

## What was found

Decisions 0049 to 0058, read together on `main` at `bd04bb3`. Three
patterns, not thirteen defects.

- **A citation by line number was broken by the merge that made it.** 0058
  cites 0052 seven times, at six lines. The same merge put 0058's pointer
  at the top of 0052, five lines long, and every citation now lands five
  lines early. Any later pointer shifts every line cited below it, so the
  convention breaks itself, one merge at a time. 0058 is the only decision
  that cites another by line. Code is cited by line in 0054 to 0058, and
  each of them names the commit it read except 0058, once.
- **Three decisions say in the present what the code does not do.**
  - 0053, *Decided*: "Erasure suspends before it anonymises (0051's
    callers)." Nothing calls a suspension, erasure calls no adapter (0056,
    *What was found*), and, run, an erased person is still held by the
    sandbox sequencer.
  - 0054, *Decided*: the refusal "comes at boot and before an enrolment, as
    a malformed declaration is refused today." Run, boot accepts a
    declaration that says `serves: "maybe"`.
  - 0055, *Decided*: "Doctrine 6 gains one line." `DOCTRINE.md` did not
    carry it.

  The folder has sections for saying what a decision does not do — *What
  this does not reach*, *Not decided here*. These three did not use them.
  And a merged decision has no way to be marked as ahead of its code: the
  three pointer forms say what replaced it, never that it is not built.
- **Fourteen pointers were missing, and three had the wrong form.** That
  breaks a rule that exists. This decision adds none for it.

## Decided

### 1. A citation names what does not move

- **A decision is cited by its number, its section, and, where the words
  matter, its sentence**, quoted: 0052, *Decided*, "nothing can carry those
  entries over to a new secret". A merged decision's headings and sentences
  never change. A pointer above them moves both down and changes neither,
  and a reader finds the sentence by searching for it.
- **Never by line number** — not in a body, a pointer or a table.
- **Code is cited by file and symbol** — `erase()` in
  `core/runtime/erase.ts`, the constant `NOT_REACHED` — **or by line at a
  named commit.** A line at a commit never moves; a line on `main` moves
  with the next change to the file. A section that cites code by line says
  once which commit it read, as 0054 to 0057 do: "On `main` at …".

Not an anchor. A heading already is one, and a link may use it
(`0052-….md#decided`). A sentence is not one, and an anchor added for it by
hand is an edit to a merged file for every citation that wants one. The
section and the quoted sentence need nothing added.

### 2. A decision says what it has not built

- ***Decided* states what must hold.** A sentence about what the code does
  *now* — in *What was found*, or as a reason inside *Decided* — is a
  finding: true at a named commit, and verified by running where it can be
  (`CLAUDE.md` §5).
- **A decision merged ahead of its code says so, in a section `## Not built
  yet`**: what of *Decided* the code does not do at merge, and at which
  commit. Not *What this does not reach*, which is what the decision leaves
  out even once built. Not *Not decided here*, which nobody has decided.
- A decision whose code lands in the same pull request has no such section.

### 3. A merged decision ahead of its code gets a note, closed, never removed

It sits with the pointers, under the title, in a blockquote:

> Not built, on `main` at `<commit>`: what of it the code does not do.

It points at no decision, so it is a note, not a fourth pointer.

**It is never removed.** The pull request that builds what it names adds,
under it:

> Built by `<commit or pull request>`: what was built.

A note removed when the code arrives erases the record that the decision
was ahead of its code. Nothing reminds anyone to remove it, either — the
same drift as a pointer nobody adds. Closed instead, the pair says when the
decision was ahead and when the code caught up, and a *Not built* with
nothing under it is visible to anyone who opens the file. A *Built by* may
close a note in part, and says which part.

A decision with a section `## Not built yet` gets the same *Built by* note
when its code lands.

### 4. What may change in a merged decision

The rule stands: a merged decision is never edited. Its reasoning stays as
written, including what turned out wrong. Four edits are permitted, all of
them to cross-references and none to what the decision says:

1. adding a pointer — *Superseded by*, *Superseded in part by*, *Completed
   by* — as before;
2. correcting a pointer's form or its target when it is wrong: a *Completed
   by* on a decision that was reversed in part says that nothing was
   reversed, and is false;
3. rewriting a line citation into the form of section 1, with the words it
   cites unchanged: the address moves, the sentence does not;
4. adding a *Not built* note, and a *Built by* under it.

Anything else — a wrong claim, a miscount, a word of reasoning — stays, and
a later decision says what was wrong, as before.

### 5. Where it is written

`decisions/README.md` carries these conventions. `CLAUDE.md` §7 points to
it, rather than describing the pointer itself: it said "the one-line
pointer" while the README describes a blockquote, and pointers have been
two to four lines long since 0040.

The pull request that merges this decision applies it to 0049–0058, and to
the decisions they point to.

## What this does not reach

- **Nothing checks it by machine.** A line citation, a missing pointer, a
  present tense ahead of the code are found by reading, as these were.
- **The decisions before 0049 were not reviewed.** Their pointers and their
  claims about code stay as they are.
- **Whether a sentence is a rule or a finding** is still the writer's
  call, and the review's. The section `## Not built yet` makes the writer
  say which one it is; it does not decide for them.
- **A *Not built* note is true only as of its commit**, like any finding.
  Nothing keeps it current except the pull request that builds.

## Rules out

- A decision cited by line number.
- Code cited by line without the commit it was read at.
- A sentence in the present about the code that the code does not hold at
  merge.
- A *Not built* note removed or rewritten, rather than closed.
- An edit to a merged decision other than the four in section 4.

## Would reverse it

- **Decision files that never change once merged, with their pointers kept
  in an index beside them.** A line would not move, and a line citation
  would hold; the index would drift from the files instead.
- **For the notes: a check that reads the code and says what a decision has
  built.** None exists, and none could read "erasure suspends before it
  anonymises".

## Not decided here

- A machine check: one that refuses `NNNN:<line>` under `decisions/`, or a
  decision that says it completes another that carries no pointer to it.
- Whether the decisions before 0049 get the same review.
