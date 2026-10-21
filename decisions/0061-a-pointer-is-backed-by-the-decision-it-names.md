# 0061 — A pointer is backed by the decision it names, from the first decision written to the form

Completes [0059](0059-a-decision-cites-what-does-not-move-and-says-what-it-has-not-built.md),
whose check reads from an introduction to the pointers it asks for, and
never back.

## What was found

On `main` at `5436fa4`.

- **The check 0059 decided reads one way.** A decision that says it
  completes another must find the pointer back. A pointer with nothing
  behind it is not read: run, a pointer kept under 0026 while 0026 is taken
  out of 0060's introduction leaves the check green. A pointer left after
  an introduction is rewritten, or put under the wrong decision, passes —
  and 0059 permits correcting a pointer's target precisely when it is wrong.
- **Reading the body instead would not catch it.** 0060 names 0026 in its
  body as well, in *What was found* and in *Decided*. A decision names in
  its body the ones it only reads.
- **Read over every decision, the other direction refuses twenty-one
  pointers, and every one is right.**
  - Seventeen are 0046's. It renames a domain, and never names the
    decisions it asks to read `gtm.x` in as `acquisition.x`. They carry the
    same form, *Completed by*, as every other pointer.
  - Two are 0012's, which has no introduction and names 0004 and 0011 in
    its body.
  - 0050's under 0041 and 0051's under 0004, which 0055 named as missing.
    Each is argued in its decision's body.

  None can be corrected by the edits 0059 permits. Removing them removes
  something true, and an introduction cannot be added to a merged decision.
- **Run on the check this decision adds, each part removed in turn:** its
  own tests fail and the others pass. With the line removed, the
  twenty-one older pointers are refused.

## Decided

**A pointer is backed by the introduction of the decision it names**,
wherever that decision was written once the introduction was the form. What
an introduction says it completes, supersedes or reverses is read as 0059
reads it. A *Completed by*, *Superseded by* or *Superseded in part by* that
names such a decision, and that its introduction does not back, is refused
by `scripts/check.mjs`, under doctrine 6.

**The line is drawn by the form, not by a date.** 0059 made the
introduction the form — three verbs, and *rests on* — so the decisions
written after it were written to it, and 0059 is the first of them. Before
it, an introduction was prose, or absent, and asking it to back a pointer
refuses pointers that are true. The check holds the line as one constant,
with this reason beside it.

**A pointer naming a decision that does not exist is refused, whatever its
age.** It is false on its face, and nothing needs to be read to know it.

## What this does not reach

- **A pointer from a decision written before the form, for good.** There
  are twenty-one today, and a wrong one among them would pass. Nothing will
  close that: those introductions cannot be rewritten, and a pointer cannot
  be checked against what its decision never said.
- **An introduction that backs a pointer it should not**: a wrong number,
  written under the form. The check reads that the two agree, not that they
  are true.
- **A pointer's form**, as 0059 says: only a reader tells a completion from
  a reversal in part.

## Rules out

- A pointer naming a decision written under the form, which its
  introduction does not back.
- A pointer naming a decision that does not exist.
- The line drawn by a number with no reason beside it.

## Would reverse it

- **An older pointer found wrong.** The decisions before the form would
  then need another way to be read — their cross-references listed beside
  them — which 0059 names and turns down.
- **A form of its own for a note that asserts neither completion nor
  replacement**, as 0046's renaming does. Its seventeen would then be
  checked by their form, and leave the uncovered set. That is not enough
  to remove the line: 0012's two, 0050's and 0051's would still need it.

## Not decided here

- A form of its own for a note like 0046's.
