# 0020 — Capacity carries every limit, and the tightest applies

Supersedes in part [0014](0014-one-sequencer-contract-every-channel.md): what
`capacity` returns.

## Decided

`capacity({ sender, channel })` returns **every** limit the provider applies
to that sender on that channel, at once:

```ts
{ sender, channel, limits: [{ unit, window, resetsAt?, limit?, used?, remaining? }], asOf }
```

**The tightest limit applies.** `remainingOf` turns a sender's limits into
what it can still do:

- the smallest `remaining`, together with the limit that binds;
- **unknown**, never the loosest of the others, if any limit does not say what
  is left: the limit nobody can read may be the one that binds;
- unknown if there is no limit at all, or if the limits count different
  things, since the smaller of two numbers in two units means nothing.

The enrolment path plans with it. An unknown remainder stops the run before
anyone is enrolled (0019).

**`window` stays closed, and widens to `hour | day | week | month`.** A new
optional `resetsAt` says when the count starts again. A rolling window has no
single reset, and leaves it out.

## Why

0014 gave capacity one `{ unit, window }` per sender and channel. A real
account commonly carries two limits on the same action at once: a weekly
ceiling and a daily pace, or an hourly rate under a daily cap. With one slot,
the adapter had to drop one. Whichever it kept, the engine planned against
something other than the truth. If it kept the looser one, it planned past the
tighter, and the provider refused the rest of the work mid-run.

## Why `window` stays closed

A free string would carry any provider's vocabulary, and the engine could
plan against none of it. "Per 24 rolling hours" and "per calendar day" plan
the same way to within a day. What differs between them — when the count
starts again — is a fact, and `resetsAt` carries it. Four periods cover the
limits seen so far. A fifth is a one-word change to this union, made the day a
provider needs it.

## Known limit: a rolling window

A closed set of windows does not express a rolling one. A ceiling of
invitations over seven rolling days never starts again all at once: each
invitation frees up seven days after it was sent, one at a time. Reported as
`window: "week"` with a `resetsAt`, it is approximated, and nothing says so.
Without `resetsAt` it is honest about not knowing when, and still says
nothing about the trickle.

What it costs: on such a limit, the engine plans against an approximation.
Within a run that is harmless, because `remaining` is read at the start and
the tightest limit binds. Across runs, a plan that expects a full week's
allowance back on a date will find it arriving piecemeal. This is free to
note now, and fixing it needs a decision after this one merges.

## What did not change

The email adapter's network calls did not change, and its pinned endpoint list
has no diff. It reports the one limit its API states for a sending account,
the daily limit, and claims no `resetsAt`, because the API does not document
its day boundary.

## Rules out

- An adapter choosing which of a sender's limits to report.
- Planning against any limit but the tightest.
- A limit with an unknown remainder treated as unlimited.

## Would reverse it

Limits that are not alternatives on one action but a budget shared across
actions — invitations and messages drawing on one pool. That would need a
unit of its own, and is not this shape.
