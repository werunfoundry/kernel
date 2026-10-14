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
| Adapters | two: an example against an invented API, and a sequencer verified read-only against a live provider (0011) |
| Published build | wired (0008); packs installed and run as an instance in CI; not yet on the registry |

## Where the work is

In this order, because each one is what the next needs.

**Audiences and suppression.** The protected-accounts path from decision 0004
now runs inside the enrolment path (0019): read whole and fresh before anyone
is enrolled, failing closed on age as well as on reachability. What remains is
withdrawing someone already enrolled when their account becomes protected
later — `suppress` exists on the sequencer (0014), and nothing calls it on a
newly protected account yet.

**The remaining adapter.** A target list. Its shape depends on answers this
repository does not have — how a target list is actually served, and whether
it can say when it was last recomputed.

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
but no write path checks a channel value yet, because no write path exists. The
check lands with the first one, for both. Once an instance has rows in these
tables, the same change is a data migration on a Postgres type. The build and
the publication make that first instance close, so this lands before it does.
Adding a vocabulary key to `domain.yaml` changes how a domain contributes its
vocabulary, which is a decision record when the change is made.

**Publication.** The packs are built, checked and run as an instance in CI
(0008). Putting them on the registry needs the `@werunfoundry` scope to exist
there, which is an account, not code.

**A first instance.** Generated from `template/`, in its own repository. It is
last on purpose: an instance built before the engine runs would be built
against intentions.

### Known unknowns

- Whether the sources behind a target list can report their own staleness. If
  they cannot, fail-closed on freshness is not implementable, and `TargetList`
  needs a different shape.
- What a contract change costs once an adapter outside this repository
  implements one. The answer is cheap today and will not stay cheap; see 0005.

## Contributing

Not open yet. See `CONTRIBUTING.md`.
