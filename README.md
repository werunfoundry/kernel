# kernel

A small engine for running a company's operating work: a governance core, and
domains that describe one line of business each.

**This is not ready.** Nothing here is stable, nothing is versioned, nothing is
supported. It is public from the first commit so that it stays generic by
construction — a public repository cannot quietly accumulate one company's
assumptions. That is the only reason it is public today.

Read `DOCTRINE.md` first. It is short, and it is the whole design.

## Layout

```
core/
  db/                 governance tables. Contains no business word.
  manifest/           what a domain declares and an instance fills in
  contracts/          what every contract is made of: context, result, error
domains/
  relations/          people, companies, audiences, interactions
    db/ contracts/    its tables; the CRM it needs
  gtm/                acquisition
    db/ contracts/    its tables; the sequencer and the target list
    manifest/         the shapes of its own truths
decisions/            boundary decisions, numbered
template/             what an instance is generated from
scripts/              checks that make the doctrine enforceable
```

## Status

| Piece | State |
| --- | --- |
| Doctrine | written, and checked by `scripts/check.mjs` |
| Schema | written; migrations generated, and applied by `kernel-migrate` in a generated instance in CI |
| Contracts | written, every capability: target list, enrichment, sequencer (every channel), inbound, metrics, CRM (0013–0018) |
| Manifest | written, validated |
| Binding resolver | written |
| Run recorder | written |
| Boot | written; resolves every name from the instance (0007) |
| End to end | in CI, a generated instance migrates, verifies and runs the enrolment path — dry, live and replayed (0019) |
| Instance template | runs as generated: every contract bound to a sandbox adapter on invented data |
| Adapters | one live sequencer, verified read-only against a real provider (0011); a sandbox for every contract; an API example to copy |
| Published build | wired (0008); packs installed and run as an instance in CI; not yet on the registry |

## Where the work is

**The rule for now: no engine capacity is added until a real instance has run
and said what it lacks.** The contract surface is closed (0013–0021). What is
left is adapters, the defects below, and the first instance. A feature built
before that instance runs is built against a guess.

In this order, because each one is what the next needs.

**Adapters.** Bound today:
- one live sequencer, the email adapter, verified read-only against a real
  workspace (0011, 0014, 0020);
- a sandbox for every contract, so a generated instance runs as is.

Next:
- **inbound and metrics on that same email provider.** Read-only. They read
  real people's replies, so they wait for the owner's explicit agreement.
- **the target list**, which waits until its data has been looked at: how it
  is served, and whether it can say when it was last recomputed.
- **enrichment and a social sequencer**, which wait for the choice of tools.

**Withdrawing someone whose account becomes protected later.** The protected
set is read whole and fresh before anyone is enrolled (0019). `suppress`
exists on every sequencer (0014), but nothing yet calls it when an account
becomes protected after enrolment.

**Lifecycle stages are a closed enum, and must not be.** A known defect, not
an open question: what to do is settled, and it gets expensive on a date.

`gtm.lifecycle_stage` is a Postgres enum — `unknown`, `targeted`, `engaged`,
`opportunity`, `customer`, `lost` — carried by `gtm.person_state` and
`gtm.company_state`. Two neighbouring fields were given the opposite
treatment, and the reasoning is written beside them. `core.experiment.type`
is text because "a Postgres enum cannot be extended by a domain without that
domain migrating a type it does not own". `relations.touch.channel` is text
because an acquisition domain and a marketing domain "do not share a closed
channel list". The vocabulary a domain declares in its `domain.yaml` —
`channels`, `experimentTypes`, `eventTypes` — exists for exactly this.
`lifecycle_stage` does not use it.

It is the same case. A lifecycle stage is not a structural fact of the engine;
it is a company's vocabulary for its own funnel. A product-led motion has
"signed up", "activated", "expanded"; a sales-led one has "SQL", "SAL". The six
values in the enum are one company's funnel, cut into a Postgres type no other
domain owns. Compare `gtm.draft_state`, which is an enum and should stay one:
it is the engine's own state machine, and the engine owns it.

The fix is about ten lines today: text, a vocabulary declared in `domain.yaml`
beside `channels`, checked against the union of the enabled domains. Note what
"like `channels`" means today: the manifest validator reads the declaration,
and the enrolment path only routes to declared channels (0015), but nothing
writes `relations.touch` or these tables yet, so no write checks a stored value.
The check lands with the first such write, for both. Once an instance has rows in these
tables, the same change is a data migration on a Postgres type. The build and
the publication make that first instance close, so this lands before it does.
Adding a vocabulary key to `domain.yaml` changes how a domain contributes its
vocabulary, which is a decision record when the change is made.

**Publication.** The packs are built, checked and run as an instance in CI
(0008). Putting them on the registry needs the `@werunfoundry` scope to exist
there, which is an account, not code.

**A first instance.** Generated from `template/`, in its own repository, with
real adapters. It decides what is built next.

### Not built yet, and recorded where it was decided

- The loop that reads inbound events into `core.event`: it needs a table for
  each adapter's cursor, which is a new core object (0017).
- Per-person enrolment outcomes are returned and printed, not stored (0019).
- A rolling window is approximated by a closed one, and the engine plans
  against the approximation (0020).
- A profile handle is not only mutable, it is reassignable: released by one
  person, it can be taken by another. The enrichment adapter's `complete`
  builds its lookup from the handle, so it must check that the profile it read
  carries the attested `social_profile_id` before accepting the result, or it
  attaches someone else's address to the original identity. Today it returns
  the provider's id when the provider sends one, and `acceptCompletion`
  rejects a mismatch; nothing checks when the id is absent, and the adapter
  does not refuse on its own.
- `assert.ok(expr)` without a message, in the rest of the test suite: under
  tsx a failure hangs instead of failing, because Node re-reads the source to
  rebuild the message. Fixed in the enrichment adapter's tests only.

### Set aside, and why

- **Managing a pool of senders** — warm-up, rotation, health — belongs to the
  provider, not to the kernel.
- **An MCP server or an HTTP API** waits until there are operations worth a
  conversation.
- **Reading runs back** — listing, filtering, dashboards — waits until there
  are enough runs to read.
- **Erasure and retention** wait until a real instance touches real people.
- **The experiment object**, beyond the row that exists, waits until a real
  campaign has run.

### Open questions

- Which tool sequences the social channels.
- What shape `Inbound` takes when one instance reads events from several
  sources at once — one binding per source, or one per event type.
- Where a diagnostic metric is declared. `experimentMetrics` now says only
  what judges an experiment (`channel_test` dropped `gtm.replied` for that
  reason), and a metric worth reading beside the judgement has nowhere to be
  named.

### Known unknowns

- Whether the sources behind a target list can report their own staleness. If
  they cannot, fail-closed on freshness is not implementable, and `TargetList`
  needs a different shape.
- What a contract change costs once an adapter outside this repository
  implements one. The answer is cheap today and will not stay cheap; see 0005.

## Contributing

Not open yet. See `CONTRIBUTING.md`.
