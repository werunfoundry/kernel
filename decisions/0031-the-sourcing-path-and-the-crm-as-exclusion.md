# 0031 — The sourcing path, and the CRM as an exclusion source

> Completed by [0032](0032-enrolment-reads-what-sourcing-kept.md): enrolment reads the people a sourcing run kept; the two commands stay two.
>
> Superseded in part by [0043](0043-the-company-pass-asks-only-what-the-run-needs.md):
> the company pass is lazy, bounded by the run, resumes after what earlier
> runs examined, and leaves no company row when the CRM fails.
>
> Completed by [0045](0045-a-kept-person-is-at-the-targeted-company.md): a kept
> person's every address must be at the targeted company, or they are
> excluded as `off_target`.

Completes [0019](0019-the-enrolment-path.md), which read the people at each
company inside the enrolment path, and [0030](0030-sources-in-sequence-by-what-they-find.md),
which said what completing changes for protection.

## Decided

**A sourcing path, separate from enrolment.** From the target list's
companies to people worth contacting, completed and recorded, with
everything excluded on the way. It enrols nobody and writes nothing to a
provider; its only paid step is completion.

**The CRM is a second exclusion source, beside protection.** A company the
CRM knows by its domain, or a person it knows by an address, does not enter
cold prospecting. The CRM is required to source at all: without one,
"unknown to the CRM" would be assumed rather than read. A CRM that cannot
answer stops the run, as protection does (0004, doctrine 6).

**The passes run in the order that decides what is paid for:**

1. Protection, read whole and fresh. Unreadable stops the run.
2. **The company pass, over every candidate, before anything is spent** —
   protection, then the CRM by domain. A CRM that fails here stops the run
   with nothing spent.
3. People at the companies kept, from the people source.
4. Completion in sequence (0030), at most `maxPeople` of them — required:
   a paid path has no default ceiling.
5. **The person pass, on the completed identity** — protection again, the
   CRM by address, the global opt-out. A person left with no address is
   excluded: neither check can conclude about them.
6. Recording the kept person by the keys the completion attested.

**A paid source's failure that is not the person's stops the run.**
Unauthorized, rate limited, unavailable: the next person would fail and
spend the same way. The message — which names the job when there is one —
is kept with the run. Nothing is retried.

**Every company and person looked at gets a row in `gtm.sourcing_result`**
— kept or excluded, in which pass, why, what the provider said about the
keys it added, what completing cost — dry runs included. A kept person in a
live run names the person recorded; a later enrolment reads the kept ones
back by run instead of sourcing, and paying, again.

## Why the company pass comes first, whole

The CRM is the cheapest refusal and the most common: a company already in
conversation. Checked company by company inside the sourcing loop, a CRM
that fails on the fifth company would stop the run after four companies'
people were paid for. Checked over every candidate first, it stops the run
before the first search.

The person pass cannot move earlier. The CRM finds people by address, and a
people source rarely returns one, so before completion the check would run
and conclude nothing — which is worse than no check (0030). What it excludes
was therefore paid for, and the report says how much.

## Rules out

- Sourcing without a CRM bound.
- A CRM or protection failure treated as "not known" or "not protected".
- Looking up the people of a company before every candidate has been
  through the company pass.
- A paid run without a ceiling.
- Retrying a paid completion, or trying the next person after a provider
  failure.

## Would reverse it

A CRM that can be asked about a person by a key a people source does return
— a profile id. The person pass would then move before completion, and
spare what it now only reports.
