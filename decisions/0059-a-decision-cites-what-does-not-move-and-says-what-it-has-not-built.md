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
- **Fourteen pointers were missing, across ten decisions written in
  forty-two hours, and three had the wrong form.** The rule existed, and
  discipline alone held it. That is what 0055 refused for the passage — a
  rule held by care — and gave a type and a check instead. Run over every
  decision, the check below found four more, older: 0012 had no pointer
  to 0019, 0004 and 0013 none to 0024, and 0013 none to 0026.

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

### 5. Two of them are checked, in `scripts/check.mjs`

Under doctrine 6, which gains the line, and against every decision:

- **A decision cited by line is refused** — `NNNN:<line>`, anywhere under
  `decisions/`, in a body, a pointer or a table. Code cited by line,
  `erase.ts:60`, is not matched.
- **A decision that says it completes, supersedes or reverses another, and
  finds no pointer back to it under that one's title, is refused.** What a
  decision says is read from its introduction: the text between its title,
  with the notes under it, and its first section. In a sentence, a number
  belongs to the last of *Completes*, *Supersedes*, *Reverses* before it.
  *Rests on* is how an introduction names a decision it builds on without
  changing it, as 0025 does, and asks for no pointer.

Each is counter-checked: removed, its tests fail, and the other rule's
pass. The form of a pointer is not read: a decision that says it completes
another may reverse part of it, as 0049 did 0040, and only a reader can
tell.

### 6. Where it is written

`decisions/README.md` carries these conventions. `CLAUDE.md` §7 points to
it, rather than describing the pointer itself: it said "the one-line
pointer" while the README describes a blockquote, and pointers have been
two to four lines long since 0040. `DOCTRINE.md` §6 carries the checked
part, as every rule `check.mjs` holds.

The pull request that merges this decision applies it to 0049–0058, and to
the decisions they point to.

## What this does not reach

- **The present ahead of the code is not checked.** No machine reads
  "erasure suspends before it anonymises" and knows it false. A *Not built*
  note is found missing by reading, as these three were.
- **Nor is a pointer's form, nor code cited by line without its commit.**
  The first needs a reader; the second has no form a pattern can tell from
  a line at a commit named a paragraph earlier.
- **An introduction that completes a decision in other words** — "builds
  on", "narrows" — is not read as completing it. The three verbs, and
  *rests on*, are the form.
- **The decisions before 0049 were read by the check only.** Their pointers
  back are complete; their claims about code were not reviewed.
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
- A decision cited by line, or one that completes, supersedes or reverses
  another with no pointer back, past `check.mjs`.
- An edit to a merged decision other than the four in section 4.

## Would reverse it

- **Decision files that never change once merged, with their pointers kept
  in an index beside them.** A line would not move, and a line citation
  would hold; the index would drift from the files instead.
- **For the notes: a check that reads the code and says what a decision has
  built.** None exists, and none could read "erasure suspends before it
  anonymises".
- **For the check: cross-references held in a field a machine reads**, not
  in an introduction's prose. The check would then read the field, and the
  verbs would stop being a form.

## Not decided here

- Whether the claims about code of the decisions before 0049 get the same
  review.
