# Decisions

A decision that moves a boundary gets a file here: what was decided, what it
rules out, and what would reverse it. One page, numbered, never edited once
merged — a later decision supersedes an earlier one and says so.

A decision gains a pointer forward, in a blockquote just under its title.
*Superseded by NNNN* — or *Superseded in part by NNNN* — when a later
decision replaces all or part of it; *Completed by NNNN* when a later
decision adds a constraint and reverses nothing. Without it the convention
has a hole — a reader lands on the old decision, believes it, and never
learns a later one replaced it. The pointer is a cross-reference, not a
revision: the reasoning underneath stays exactly as it was written,
including the parts that turned out wrong.

Four edits are permitted on a merged decision, all of them to
cross-references, none to what it says
([0059](0059-a-decision-cites-what-does-not-move-and-says-what-it-has-not-built.md)):

1. adding a pointer;
2. correcting a pointer's form or target when it is wrong;
3. rewriting a citation by line number into the form below, the words it
   cites unchanged;
4. adding a *Not built* note, and a *Built by* note under it.

**A citation names what does not move.** A decision is cited by its number,
its section, and, where the words matter, its sentence, quoted — never by
line number: every pointer added above a line moves it. Code is cited by
file and symbol, or by line at a named commit ("On `main` at …").

**An introduction says what a decision changes.** *Completes*, *Supersedes*
or *Reverses* names a decision it changes; *rests on* names one it only
builds on. `scripts/check.mjs` refuses a citation by line, and a decision
that changes another which carries no pointer back to it. It also refuses
a pointer its decision's introduction does not back, for decisions written
to this form, and a pointer to a decision that does not exist
([0061](0061-a-pointer-is-backed-by-the-decision-it-names.md)).

**A decision says what it has not built.** One merged ahead of its code
says so in a section `## Not built yet`. One already merged that is ahead
of its code gets a note among its pointers —
*Not built, on `main` at <commit>: …* — which is never removed: the pull
request that builds it adds *Built by <commit or pull request>: …* under it.

The rule behind the folder: a decision taken only in a conversation does not
exist. Six months later the code shows *what* was built and nobody remembers
what was considered and dropped, so the question gets reopened from scratch and
answered differently. These files are the memory of the alternatives.

Not every choice belongs here. A boundary is: a new object in the core, a
dependency between domains, a new package, a change to what an instance owns,
or a rule in `DOCTRINE.md`.
