# 0034 — An uncovered customer stops the run until a person acknowledges it

Completes [0033](0033-protection-matches-the-company-id-and-is-not-an-identity.md),
which left an account with no key stopping every run.

## Decided

**Protection counts customers, not rows.** A source may group its accounts
by customer — several workspaces of one customer. A protected account may
name its customer (`customerId`), and the run counts customers, and says
what it matches on: the distinct domains and company ids. The customer is
used to count and to acknowledge. **It is never matched on**: a candidate is
protected by keys only.

**A row with no key is harmless when its customer has a key elsewhere.**
The customer is matched through that other row, and the run counts such
rows.

**A customer with no key on any of its rows is uncovered**: nothing can
match it, so nothing protects it. An uncovered customer nobody has
acknowledged **stops the run, naming itself**. An acknowledged one lets the
run go on, and every run says which acknowledged customers it could not
protect. A row with no key and no customer still stops the run, as before:
there is nobody to acknowledge.

**Acknowledging is a person's act.** `kernel-acknowledge` records it — the
customer, why, and who — each acknowledgement and each withdrawal in its
own run with the person as actor. It refuses to write without a terminal,
and asks for the customer's id to be typed again. The schema refuses an
acknowledgement whose actor is not a person. Runs read the acknowledged
set and never write it; a test reads the runs' sources to hold that.
Withdrawn acknowledgements stay, so the record says who covered what, and
when it ended.

## Why not a number in the manifest

A ceiling ("up to N uncovered") lets a different customer fall through the
same hole the day one is fixed and another breaks: the count stays the
same and nobody looks. An acknowledgement names the customer, so a new
uncovered customer stops the run, and says who it is, however many are
already acknowledged.

## Rules out

- Matching a candidate on the customer id.
- A run, or a scheduled job, acknowledging a customer.
- An uncovered customer passing without being named — stopping the run, or
  reported by it.
- A ceiling on uncovered customers in place of naming them.

## Would reverse it

A source that keys every customer. The acknowledged set would then be empty,
and the rule would cost nothing. Removing it would be a decision that a
customer with no key may be contacted — which is what it exists to prevent.
