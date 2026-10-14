# Decisions

A decision that moves a boundary gets a file here: what was decided, what it
rules out, and what would reverse it. One page, numbered, never edited once
merged — a later decision supersedes an earlier one and says so.

One kind of edit is permitted, and only one: a decision gains a pointer
forward, in a blockquote just under its title. *Superseded by NNNN* — or
*Superseded in part by NNNN* — when a later decision replaces all or part of
it; *Completed by NNNN* when a later decision adds a constraint and reverses
nothing. Without it the convention has a hole — a reader
lands on the old decision, believes it, and never learns a later one replaced
it. The pointer is a cross-reference, not a revision: the reasoning underneath
stays exactly as it was written, including the parts that turned out wrong.

The rule behind the folder: a decision taken only in a conversation does not
exist. Six months later the code shows *what* was built and nobody remembers
what was considered and dropped, so the question gets reopened from scratch and
answered differently. These files are the memory of the alternatives.

Not every choice belongs here. A boundary is: a new object in the core, a
dependency between domains, a new package, a change to what an instance owns,
or a rule in `DOCTRINE.md`.
