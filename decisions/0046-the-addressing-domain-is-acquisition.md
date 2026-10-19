# 0046 — The addressing domain is `acquisition`, and a domain may be renamed

## Decided

**The domain called `gtm` is renamed `acquisition`.** "GTM" names a strategy
that spans product, pricing, sales and customer success; this domain does
none of that. Its verbs are to source, qualify, select, draft, enrol, and
measure what comes back. `acquisition` names exactly that, and stands beside
the domains that will sit next to it — support, product, retention.

What changes:

- **The Postgres schema** `gtm` becomes `acquisition`, with its tables, views,
  enums (`unreadable_key` and `off_target` included), functions and
  triggers. Table and value names do not change; they follow the schema.
- **The package** `@werunfoundry/gtm` becomes `@werunfoundry/acquisition`,
  and the folder `domains/gtm` becomes `domains/acquisition`. Export paths are
  unchanged.
- **Every name the domain prefixes with its own**, because a domain's event
  types and metrics must carry its name (0018): the five event types
  (`signup`, `reply`, `bounce`, `unsubscribe`, `meeting_booked`), the
  **five** metrics (`enrolled`, `replied`, `bounced`, `unsubscribed`,
  `meetings_booked` — the brief listed four; `enrolled` was missing, which is
  why the inventory came before the code), and the process keys new runs
  carry (`acquisition.source`, `acquisition.enrol.<sequence>`, …).

**A domain may be renamed: `formerly`.** A domain lists, in its
`domain.yaml`, the names it was known by. Before migrating a layer,
`kernel-migrate` finds the record of what was applied under a former name
and carries it to the current one, so nothing is replayed. It refuses when
records exist under both names, since it could not tell which is true. Any
domain renamed later uses the same field; it is a capacity of the kernel,
not a case for this one.

What `formerly` guarantees: migrations applied under a former name are
recognised under the new one. What it does not:

- **It does not rename the schema.** The domain's own migration does that,
  as this one does.
- **It does not rename data.** Rows keep the names they were written with.
- **It does not make an instance follow.** An instance that still enables
  the old name, installs the old package, or binds adapters that declare the
  old event types or metrics is refused when it boots, by the checks that
  already exist. It changes its manifest, its dependency and its adapters.

**The migration is not additive.** It renames the schema and rewrites the
one function whose body named the old schema in full. The data stays where
it is. It can be undone by renaming back, with `formerly` listing
`acquisition` on the other side.

## What stays `gtm`, and how to read it

- **Decisions 0001 to 0045.** They say what was decided, under the name of
  the time. Read `gtm` as `acquisition`: `gtm.draft` is `acquisition.draft`,
  `gtm.reply` is `acquisition.reply`, `gtm.replied` is
  `acquisition.replied`. Each carries a pointer here.
- **The migrations already applied** (`0000` to `0014`) and their
  snapshots. They are what ran. An installation from nothing runs them as
  written, creating `gtm`, then this one renames it.
- **Runs recorded before the rename.** Their process keys stay `gtm.*`. A
  run says what happened, under the name in force when it ran.
- **The commands**: `kernel-source`, `kernel-enrol` and the others keep
  their names.

## Rules out

- Rewriting a decision, an applied migration or a recorded run to the new
  name.
- Renaming a domain without listing its former name.

## Would reverse it

A domain whose verbs grow into the whole go-to-market motion — pricing,
packaging, customer success — so that `acquisition` named only part of it.
Renaming again would use the same field.
