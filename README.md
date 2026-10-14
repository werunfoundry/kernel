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
decisions/            boundary decisions, numbered
    manifest/         the shapes of its own truths
template/             what an instance is generated from
scripts/              checks that make the doctrine enforceable
```

## Status

| Piece | State |
| --- | --- |
| Doctrine | written |
| Schema | written, unmigrated |
| Contracts | written |
| Manifest | written, validated |
| Adapters | one reference adapter |
| Instance template | written |
| Template | not started |

## Contributing

Not open yet. See `CONTRIBUTING.md`.
