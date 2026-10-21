# 0012 — One provider workspace per instance

> Completed by [0015](0015-one-adapter-per-contract-and-channel.md): the kernel binds one adapter per contract and channel.

> Completed by [0019](0019-the-enrolment-path.md):
> the enrolment path reads protection itself, fail-closed, before any
> provider is called.

## Decided

**A workspace at a provider serves one instance.** Two instances never share a
sequencer's workspace, or any provider account whose state is workspace-wide.

**An instance may use several providers for the same capability** — one for
email, one for social messages, one that does both. That is the opposite
direction, and it is allowed in principle. Today it is blocked by a limit of
the kernel, not by this decision: a manifest may bind one adapter per contract
(`core/manifest/validate.ts` refuses a contract bound twice;
`core/runtime/resolve.ts` files adapters by contract name). The README lists
it. It is not fixed here.

**A provider's blocklist is defence in depth, not protection.** Protection is
the `protectedAccounts` route of the `TargetList` contract (0004), checked by
the kernel before an enrolment. A provider whose blocklist fails, empties, or
was never written must never be the reason a protected account is contacted.
The kernel never treats a successful `suppress`, or the presence of an entry,
as what makes an enrolment safe.

One thing the record must be exact about: today nothing performs that check.
The route exists in the contract and no code calls it, because no enrolment
path exists yet. This decision binds the first one.

## Why one workspace per instance

A provider's workspace holds state that belongs to whoever uses it, and does
not say who that is.

**The blocklist is workspace-wide.** The sequencer adapter writes suppression
as a blocklist entry (0011), and the provider applies the blocklist to every
campaign in the workspace. Two instances sharing one would suppress each
other's targets, and neither could answer "which run suppressed this?" — the
question doctrine 5 says every action must answer. An entry carries no run,
and the other instance's runs are in another database.

**Capacity is workspace-wide.** `capacity` reads what a sender has left today.
A sender shared by two instances is spent by both, and each would size its
plans on the other's consumption. The provider's rate limit is also per
workspace, shared by every key.

**Withdrawal reaches across.** An entry or a deletion made by one instance
changes sequences the other is running, with no record on the other side.

## Why the blocklist cannot be the protection

Read in the provider's published API, not assumed:

- Entries can be listed, and removed one at a time or in bulk. **A single call
  removes every entry**, optionally filtered. Any key holding the delete scope
  can do it.
- Removing an entry is documented. **What removing one does to leads it had
  already caused to be skipped is not**: whether they resume is not stated.
  The entry is reversible; its effect may not be.

A protection that one request can empty, and whose undoing has undocumented
effects, can back up a decision and must never make it. Protection that fails
closed (doctrine 6) has to live where its freshness can be checked — in the
kernel, against the target list.

## Open

**An agency running several instances.** One operator, several clients, each
an instance. Whether they may share anything at a provider — an account, a
workspace with sub-workspaces, a sender pool — is not decided here, and
nothing in this record should be read as an answer.

## Rules out

- Two instances on one provider workspace.
- Treating a provider's blocklist, or a successful `suppress`, as the check
  that allows an enrolment.

## Not checked

Nothing can check the first rule: each instance sees only its own manifest and
its own database, and the kernel cannot see across instances. It holds by
being written here.

## Would reverse it

A provider whose workspace state is attributable — every blocklist entry and
every send carrying the instance that made it, readable through the API — and
capacity that can be partitioned per instance. That would let two instances
share one honestly. The second rule does not reverse: protection that a
provider can lose is not protection.
