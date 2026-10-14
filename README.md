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
| Schema | written; migrations generated and applied in CI |
| Contracts | written; one of them implemented |
| Manifest | written, validated |
| Binding resolver | written |
| Run recorder | written |
| Boot | written; resolves every name from the instance (0007) |
| End to end | once: boot, a dry run, one adapter call, the run closed — `pnpm verify` in an instance |
| Instance template | written, with one reference adapter |
| Adapters | one, against an invented API |
| Published build | wired (0008); packs installed and run as an instance in CI; not yet on the registry |

## Where the work is

In this order, because each one is what the next needs.

**Audiences and suppression.** The protected-accounts path from decision 0004,
failing closed on freshness as well as on reachability. This is the one that
carries real consequence: everything else here fails by not working, and this
one fails by contacting someone it should not have.

**The remaining adapters.** A sequencer and a target list. Their shape depends
on answers this repository does not have — how a target list is actually
served, and whether it can say when it was last recomputed.

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
