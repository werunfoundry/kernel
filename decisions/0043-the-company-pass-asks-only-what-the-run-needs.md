# 0043 — The company pass asks only what the run needs

Supersedes in part [0031](0031-the-sourcing-path-and-the-crm-as-exclusion.md):
its company pass ran "over every candidate", and "every company looked at
gets a row" no longer holds when the CRM fails.

## Decided

### 1. A batch does not lower the cost against a score limit

The CRM limits its record queries by a **complexity score**, not only by a
count of requests, summed over a sliding window across every token, with no
values published. It returns each query's score in a response header.
Measured on 2026-10-16, read-only, one query each:

| Domains in one `$or` query | Score the CRM returned |
|---|---|
| 1 | 145 |
| 20 | 2902 |

The score grows with the number of domains asked — twenty is twenty times
one, to within two points. So asking 200 domains costs the same score in
batches of twenty as one at a time. The batch saves round trips, not score.
It removes the involuntary pacing those round trips gave. And a refusal for
the window now costs twenty domains at once instead of one.

**The batch stays**: it is the right shape on the day many domains must be
asked at once. It is not what reduces the cost. Asking less is.

### 2. The company pass is lazy, and bounded by what the run asks

A run asks for at most `maxPeople` people at `peoplePerCompany` per company.
It needs about `ceil(maxPeople / peoplePerCompany)` companies to survive the
company pass. Examining the whole pool to find them spent the score on
companies no run would reach. In one run, 185 companies were examined for
10 people at one per company.

The company pass now reads the candidates **in batches of twenty**. Each
batch goes through protection and the domain check, then the CRM, and the
pass stops **as soon as enough have survived**. Enough is the companies the
ceiling needs **plus a quarter of that again, at least one**: a surviving
company may yield nobody, or only people the person pass excludes.

**If the candidates run out first, the pass stops there and says so** — how
many survived against how many were wanted. The run goes on with what
survived. It does not reach for another page of candidates.

### 3. A cursor: what a previous run examined is not asked again

A company a previous live run examined is skipped. "Examined" means it has a
row in `gtm.sourcing_result` from a run that was not a dry run, whatever the
outcome, except `not_reached`: a company the ceiling stopped before is not
yet examined, and comes back first. Without this, every run would ask the
CRM about the same first twenty domains again.

The cursor is a set, not a position, because a target list's order and its
own page tokens do not outlive a run. A dry run reads the cursor and does
not advance it: what it decided is not acted on.

### 4. A CRM failure leaves no company row

The company pass writes its rows only once it has finished. A CRM that fails
in any batch stops the run with no company row written for that run — not
for the batches already answered either. 0031 said every company looked at
gets a row. Since #78, and now by design, a run that stopped in the company
pass has none: a partial set of rows would read as a complete pass, and the
cursor would take it for one.

## Not done here

- **The skipped set is read whole on each run**, from every live run's rows,
  with no index of its own. Fine at the volumes seen; an index on the
  company's domain is the answer when it is not.
- **Skipping is the safe direction only.** A company once excluded — known to
  the CRM, protected — is not looked at again, even if that changes. That
  costs a prospect, never a wrong contact. A way to examine a company again,
  on purpose, is not built.

## Rules out

- The company pass over the whole pool when the run needs a handful.
- A run asking the CRM again about what a previous live run examined.
- A partial set of company rows standing for a company pass that failed.

## Would reverse it

A CRM limit by request count rather than by score — then the batch alone
would be the saving — or a run whose ceiling is the pool itself.
