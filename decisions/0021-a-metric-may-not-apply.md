# 0021 — A metric reading may be "not applicable"

Supersedes in part [0018](0018-measurement-reads-little.md): the shape of
what `MetricSource.read` returns.

## Decided

`MetricSource.read` returns one of two readings:

```ts
| { key, applicable: true,  value, unit?, asOf, source }
| { key, applicable: false, why,          asOf, source }
```

A domain declares on which channels a metric means something
(`MetricDeclaration.channels`; absent means every channel). `gtm` scopes
`gtm.bounced` and `gtm.unsubscribed` to `email`. A query may name a channel.

## What the shape guarantees

- **A number is a measurement.** Every `value` the engine reads came from a
  metric that applies where it was asked.
- **The kernel answers for the declaration, not the source.** `readMetric`
  does not ask a source about a channel its metric is scoped away from: the
  answer is "not applicable" whatever the source would have said.
- **Measurability is per channel.** A metric that does not apply on a channel
  is neither missing nor counted there. A channel on which none of a type's
  metrics applies is never measurable for that type.

## What it makes impossible

**Reading "not applicable" as zero.** The second variant has no `value`
field, so code that sums, compares or thresholds a reading has to look at
`applicable` first, and the type checker enforces it. Before this change, a
guardrail on a channel that cannot bounce returned 0. A guardrail that reads
zero by construction guards nothing, and passes every check that is written
against it.

This is the rule [0009](0009-a-contract-may-be-probed.md) set for probes —
an adapter that offers no probe is reported as offering none, never as
healthy — applied to numbers. Nothing new is being decided about honesty. What
is decided here is the shape that carries it, because a change to a contract's
shape is a decision, as it was for `Sequencer` in
[0014](0014-one-sequencer-contract-every-channel.md).

## What it costs

Every metric source must now say, for each reading, whether it applies. A
source with no notion of channels answers `applicable: true` and is done. The
`value` that 0018 left as a bare number is now behind a discriminant.

## Rules out

- A zero standing for "this does not exist here".
- A type measurable only on the strength of metrics that apply nowhere it
  runs.
- A source overruling the domains' declaration of where a metric applies.

## Would reverse it

A metric whose absence on a channel is genuinely a count of zero: something
that could happen there and did not. That metric is not scoped to channels,
and needs no reversal. What would reverse this decision is a reader that
cannot handle two variants — a warehouse export, a spreadsheet — and needs
every cell filled. The answer to that reader is an explicit marker in its own
format, not a zero in ours.
