# The warehouse target list

`TargetList` read from two tables the binding names: candidates from a
target table filtered on a status, the protected set from a customer
accounts table filtered on its active values. The binding, every option and
every fail-closed rule are documented at the top of `index.ts`; this file is
what an instance should know before it schedules a run.

## What a read costs

The warehouse bills the columns a query references, over every row of what
it reads, whatever the filter — and **a view is read by running it**. Its
cost is whatever the view computes, not the size of what it returns.

Measured on the first instance that bound this adapter: its customer
accounts were a view, and reading the protected set — 1,277 rows, three
columns — scanned **9.5 GB**. The protected set is read whole before every
enrolment (decision 0019), so a scheduled enrolment pays that on every run.

**The protected route over that view is not usable as is on a scheduled
run.** This adapter does not work around it: which table holds the protected
accounts is the instance's choice, and the usual answer is a table the view
is materialised into on the warehouse's own schedule, with its extraction
time in a column for `freshness` to read. Two things the adapter offers in
the meantime:

- `maximumBytesBilled` refuses any query that would bill more than the
  binding allows. Set it, and a read that would cost too much fails — closed,
  like any other failure of the protected route — instead of being paid.
- `probe` dry-runs both routes' freshness queries, which bill nothing.
  It does not price the protected read; a dry run of that query, made once
  from the warehouse's console, does.

## An unknown subscription stops the run

An account whose active column is NULL is neither active nor inactive. The
protected read returns those rows too, and one of them stops it: an unknown
subscription is not an absent one, and protecting less in silence is the
failure doctrine 6 exists for. Measured on the same instance: no NULL among
its 1,277 accounts, so the rule blocks nothing there today.

## One row written by hand can make a stale table read fresh

The protected route's age is its table's **oldest** extraction time by
default: a row added today cannot make an old table look younger, only the
reverse, which fails closed. With `protected.freshness: newest`, the age is
the **latest** extraction time, and one row dated today — written by hand,
or by a load that touched one row — makes a table whose other rows are weeks
old read as fresh. That is a stale answer that looks like protection, the
failure doctrine 6 names first.

So a row is never written into the protected table by hand, and least of
all to exercise protection on a test company: in a table rebuilt on the
warehouse's schedule it is gone at the next rebuild, in a view it has to be
written upstream — a customer that does not exist, in the billing or the
CRM — and under `newest` it lies about the age of every other row. A test of
protection belongs on a company the protected set already holds.
