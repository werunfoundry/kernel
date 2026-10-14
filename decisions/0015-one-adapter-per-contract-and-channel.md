# 0015 — One adapter per contract and channel

Completes [0012](0012-one-provider-workspace-per-instance.md), which allowed an
instance several providers for one capability and recorded that the kernel
could not yet hold them.

## Decided

A contract may be bound more than once, **one adapter per channel**.

- An adapter whose contract is about channels declares the ones it serves, in
  `channels` — now an optional member of every `Contract`.
- A binding may name `channels`, to take some of them; by default it takes
  all the adapter declares.
- A contract bound more than once is bound per channel. Every binding must
  take at least one channel, and no channel may be taken twice. The refusal
  names both bindings.
- Every channel — named by a manifest or declared by an adapter — must be one
  an enabled domain declares.

The registry answers by channel: `forChannel(contract, channel)` for the
adapter that takes it, `all(contract)` for every adapter bound to it.
`get(contract)` and `require(contract)` still answer for a contract bound once.
For a contract bound per channel they **throw**, rather than return one of the
adapters at random.

## Why per channel, and not by name or by priority

**The channel is already the question the caller asks.** An enrolment names a
channel (0014). Routing by it needs no new word, and a manifest reads as what
it is: email through this tool, social messages through that one.

**A name per binding was the alternative.** `sequencer:email`,
`sequencer:social`, chosen by the caller. It moves the routing into every
caller, and two callers spelling it two ways is the identity problem again,
one level up.

**Priorities or fallbacks were refused.** "Use A, else B" on the same channel
means a failure in A silently sends through B. For outreach that is the
difference between "not sent" and "sent by the tool nobody was watching".

**`all` exists because of suppression.** Suppressing someone is suppressing
them on every channel (0014), so whatever suppresses must reach every adapter
of the contract, not the one for a channel.

## Rules out

- Two adapters on the same channel of one contract.
- A fallback adapter for a channel.
- Answering "the" adapter of a contract bound per channel.

## Would reverse it

A channel that genuinely needs two providers at once — a volume that one
provider's limits cannot carry. That would be a split by sender, not by
channel, and it is a decision for the day it is needed.
