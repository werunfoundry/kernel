# kernel

A small engine for running a company's operating work: a core that records the
work — who acted, what is being tried, what ran, what was observed, what was
concluded — and domains, each a set of verbs on that record with the objects
only those verbs touch. Never a team (0035).

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
  relations/          people, companies, lists, interactions
    db/ contracts/    its tables; the CRM it needs
  acquisition/                acquisition
    db/ contracts/    its tables; the sequencer and the target list
    manifest/         the shapes of its own truths
adapters/             one folder per provider, satisfying the domains' contracts
decisions/            boundary decisions, numbered
template/             what an instance is generated from
scripts/              checks that make the doctrine enforceable
```

## Status

| Piece | State |
| --- | --- |
| Doctrine | written, and checked by `scripts/check.mjs` |
| Schema | written; migrations generated, and applied by `kernel-migrate` in a generated instance in CI |
| Contracts | written, every capability: target list, people source, enrichment, sequencer (every channel), inbound, metrics, CRM (0013–0018, 0030) |
| Manifest | written, validated |
| Binding resolver | written; a contract bound once, per channel (0015), or in sequence by the keys each source finds (0030) |
| Run recorder | written |
| Boot | written; resolves every name from the instance (0007) |
| End to end | in CI, a generated instance migrates, verifies and runs the enrolment path — dry, live and replayed (0019) |
| Sourcing path | written (0031): company pass by protection and the CRM before any spend — lazy, only as far as the run needs, resuming after what earlier live runs examined (0043) — people, completion in sequence, person pass on the completed identity; tested against a real database with in-memory adapters, not yet run on an instance; `kernel-enrol --from-run` enrols what a sourcing run kept (0032) |
| Instance template | runs as generated: every contract bound to a sandbox adapter on invented data |
| Adapters | one live sequencer, verified read-only against a real provider (0011); a warehouse target list, run against a fake of its API only; a people source and enrichment on a social network, and an asynchronous paid enrichment, both against fakes of their APIs only; a sandbox for every contract; an API example to copy |
| Published build | wired (0008); packs installed and run as an instance in CI; not yet on the registry |

## Where the work is

**The rule for now: no engine capacity is added until a real instance has run
and said what it lacks.** The contract surface is closed (0013–0022). What is
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
- **the target list, against a real warehouse.** The adapter reads candidates
  and protected accounts from two tables and its age from an extraction
  column; it has run against a fake of the warehouse's API, not a real one.
- **enrichment and a social sequencer**, which wait for the choice of tools.

**Withdrawing someone whose account becomes protected later.** The protected
set is read whole and fresh before anyone is enrolled (0019). `suppress`
exists on every sequencer (0014), but nothing yet calls it when an account
becomes protected after enrolment. The registry (0026) is what makes it
answerable: it records the company each person was enrolled through.

**Lifecycle stages are a closed enum, and must not be.** A known defect, not
an open question: what to do is settled, and it gets expensive on a date.

`acquisition.lifecycle_stage` is a Postgres enum — `unknown`, `targeted`, `engaged`,
`opportunity`, `customer`, `lost` — carried by `acquisition.person_state` and
`acquisition.company_state`. Two neighbouring fields were given the opposite
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
domain owns. Compare `acquisition.draft_state`, which is an enum and should stay one:
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

- A rolling window is approximated by a closed one, and the engine plans
  against the approximation (0020).
- `assert.ok(expr)` without a message, in the rest of the test suite: under
  tsx a failure hangs instead of failing, because Node re-reads the source to
  rebuild the message. Fixed in the enrichment adapter's tests only.

**Protection reads a table built for it, and names what it cannot protect.**
The protected route's freshness reads the time the table was built (0019,
doctrine 6) — never a time computed when the query runs, which would make
every read look fresh. Accounts match on their domain or their company id,
either enough (0033), and are counted by customer. A customer with no key on
any of its rows is protected by nothing: it stops every run, naming itself,
until a person acknowledges it with `kernel-acknowledge` — and every run then
says it is uncovered (0034). Giving it a key upstream is the fix; the
acknowledgement only makes the hole visible and owned.

#### The objects phase 3 was going to build — what exists, and what is not wired

Most of what the core needs is already in the schema. What is missing is
whatever writes it, reads it, or connects it to the rest.

**`core.experiment`**
- *There:* a unique `slug`; `type` as text, from the domains'
  `experimentTypes`; `status` (`draft`, `running`, `measuring`, `validated`,
  `killed`); `hypothesis_ref`, the objective that lives elsewhere, as a
  reference; `lane` and `autonomy_streak`; `targets`; `metric`,
  `kill_threshold`, `minimum_sample`, `budget_eur`; the run window and the
  measurement window; `baseline_snapshot`. The domains declare `metrics` and
  `experimentMetrics`, and `kernel-verify` reports which experiment types the
  bound metric sources can judge (0018).
- *Written by:* nobody creates one. `core/runtime/experiment.ts` writes
  `autonomy_streak` only, on each human review (0027).
- *Read by:* `laneOf` (lane and streak), the draft's gate (`status` must be
  `running` to queue) and the message's (`lane` and `status`, for a lane's
  approval — 0038). `acquisition.template`, `acquisition.draft`, `relations.message` and
  `relations.touch` reference it.
- *Not wired:* a writer that creates an experiment and checks its `type`
  against the declared types; the status transitions, enforced in the schema
  as the draft's are; anything that reads the threshold, the sample, the
  budget, the windows or `targets`; the link to enrolment — the enrolment path
  enrols into a `sequenceKey`, the registry (0026) has no experiment, and the
  provider's campaign is an adapter option, so "the experiment replaces the
  campaign" is that link, not a new table.

**`core.decision`**
- *There:* one line a person writes about an experiment (0039): the
  experiment, the conclusion, why, and the `readings` it rested on, frozen as
  read. Append-only and a person's, in the schema.
- *Written by:* `recordDecision` (`core/runtime/decision.ts`), each in its
  own run, which a person reaches through `kernel-decide`, at a terminal
  (0047). *Read by:* nobody yet.
- *Not wired:* reading the figures — `readMetric` in
  `core/manifest/measure.ts` reads one through a source and applies the
  not-applicable rule (0021), and nothing but its tests calls it; the only
  metric source bound anywhere is the sandbox; tying a decision to the
  experiment transition it causes (killed, validated, extended), and writing
  `baseline_snapshot` when the measurement window opens.

**`core.event`**
- *There:* appended and never updated (0039), unique on the source and its
  event id, with when it happened and the run that read it. Whether an event
  was handled is a run naming it (`run.event_id`).
- *Written by:* `recordEvent` (`core/runtime/event.ts`), which refuses an
  undeclared type, called by `kernel-inbound`: each source bound to `acquisition`'s
  `Inbound` is read after its cursor (`acquisition.inbound_cursor`, locked for the
  read: one writer per source), and each event is stored once, with an
  inbound `touch` when it names a recorded person and a declared channel,
  and the opt-out applied for `acquisition.unsubscribe`.
- *Read by:* nobody directly. The inbound touch written beside it is read
  by the reactive lane, in the draft's gate and the message's: a touch from
  the person, on the channel, inside the caller's window, licenses a reply
  (0042).
- *Not wired:* a metric source over the event record; a process an event
  triggers.

**Processes**
- *There:* `run.process_key`, written as free text — `instance.verify`,
  `acquisition.enrol.<sequence>`; `run.trigger`, an enum (`webhook`, `cron`, `cli`,
  `manual`) of which only `cli` is written: each command passes it to its
  verb (0048). Runs recorded before 0048 by an erasure or a person's
  declaration, list or decision read `manual`, which stays in the enum.
- *Not there at all:* a process. `core.run`'s comment says a process key
  matches "a process declared in the manifest", and the manifest has no such
  field. Nothing declares a process, nothing schedules one, and nothing routes
  an event to one. 0017 rules out a webhook endpoint in the kernel, so a
  trigger is a pull on a schedule or a command — and what a process *is* has
  to be decided before anything triggers it.

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
  what judges an experiment (`channel_test` dropped `acquisition.replied` for that
  reason), and a metric worth reading beside the judgement has nowhere to be
  named.

### Known unknowns

- Whether the sources behind a target list can report their own staleness. A
  warehouse table with an extraction column can, and the adapter reads its
  oldest row by default; any other source is still an open question. One
  that cannot makes fail-closed on freshness unimplementable, and `TargetList`
  would need a different shape.
- What a contract change costs once an adapter outside this repository
  implements one. The answer is cheap today and will not stay cheap; see 0005.

## Contributing

Not open yet. See `CONTRIBUTING.md`.
