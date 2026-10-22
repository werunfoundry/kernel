# 0032 — Enrolment reads what sourcing kept, and the operator stands between

> Superseded by [0068](0068-an-account-no-company-on-record-can-match-stops-the-enrolment-until-named.md): an
> enrolment no longer reads a sourcing run; what a run kept reaches a person
> through a list, which a person constitutes.

Completes [0031](0031-the-sourcing-path-and-the-crm-as-exclusion.md), which
recorded the people a sourcing run kept for a later enrolment to read.

## Decided

**Enrolment can take its people from a sourcing run.** Given a run, it
considers exactly the people that run kept, with the keys their completion
attested, and finds nobody itself. Only a live sourcing run that finished —
succeeded, or partial after keeping someone — can be enrolled from; a dry
run, a failed run or another process's run is refused before an enrolment
run is opened.

**Sourcing never enrols, and enrolment never sources from a run.** They
stay two commands. Between them a person reads the sourcing report: who was
kept, who was excluded and why, what it cost. That gap is the operator's
gate, and what "nothing left but to press send" assumes.

**What sourcing decided is not trusted past the moment it decided it.**
Enrolling from a run reads protection fresh and checks the opt-out and the
registry again, as any enrolment does. A second enrolment from the same run
enrols nobody: the registry (0026) answers it.

**The opt-out is read by every path that contacts anyone.** Enrolment now
skips a recorded person who opted out, with its own reason, as sourcing
already excluded them. One path refusing what the other accepts would make
the opt-out a matter of which command was run.

## Rules out

- Enrolling anyone a sourcing run did not keep, from that run.
- A command that sources and enrols in one go.
- Enrolling an opted-out person by any route.

## Would reverse it

An enrolment that must happen without anyone reading in between — a
scheduled one. It would need the gate written down in place of the person:
a rule for what a report must say before its people may be enrolled.
