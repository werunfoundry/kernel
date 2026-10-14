# 0018 — Measurement reads little, and says what it cannot read

## Decided

`MetricSource` gets work to do, and the six experiment types get a surface.

- **A domain declares its metrics** in `domain.yaml`, namespaced like its
  events, each with a unit. `gtm` declares five: `gtm.enrolled`,
  `gtm.replied`, `gtm.bounced`, `gtm.unsubscribed` (people) and
  `gtm.meetings_booked` (meetings).
- **A domain says what each experiment type is judged on**, in
  `experimentMetrics`. `message_test` is judged on enrolled and replied;
  `offer_test` on enrolled and meetings booked; and so on for all six.
- **A metric source says which keys it can read**, in `metrics`. A source
  claiming a key no enabled domain declares is refused at boot.
- **`measurability`** tells, per experiment type, whether the bound sources
  can read every metric it is judged on. `verify` reports it. A type judged on
  nothing is never called measurable.

`read` is unchanged in shape. Its contract now says that a source that could
not compute a number returns an error, never a zero, because zero is a
measurement.

## Why this little

The engine keeps no numbers except inside a decision's snapshot (doctrine 3).
Measuring an experiment here means two things: knowing before it runs that it
can be judged, and reading the numbers when someone decides. Both fit in a
declaration and one read.

The alternative was a contract that returns series, breakdowns, or results by
variant with intervals. It would promise a warehouse, and every instance would
implement the promise differently. The breakdown an experiment needs is
expressed instead in `params` — an experiment slug, a variant — passed through
to the source untouched.

## What it deliberately does not do

- **No series and no history.** One number for one window, read when needed.
- **No statistics.** No significance, no winner, no confidence interval. A
  decision rests on the numbers and on the people who read them, and the
  snapshot keeps both.
- **No storage.** Nothing here writes a number anywhere.
- **No query language.** A source answers declared keys, not arbitrary
  questions.

## Not a failure

An instance that cannot measure an experiment type still boots and still
verifies: it may not run experiments. `verify` says so, so that nobody learns
it after the experiment has run.

## Rules out

- A metric key not declared by an enabled domain.
- A zero standing for a number that could not be computed.
- Calling a type measurable when it is judged on nothing.

## Would reverse it

Experiments whose judgement needs something a single number per window cannot
carry — a distribution, a curve. They would need a richer read, and a decision
about where its result lives.
