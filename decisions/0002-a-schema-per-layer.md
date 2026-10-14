# 0002 — One Postgres schema per layer, dependencies declared

## Decided

`core` is a Postgres schema. Each domain is a Postgres schema of its own name.
A domain declares what it depends on in its `domain.yaml`; a foreign key may
point into `core` or into a declared dependency, and nowhere else. Installing a
domain is creating its schema; uninstalling it is `DROP SCHEMA`.

Migrations are per layer, each with its own journal, applied in dependency
order.

## Why

Table prefixes were the alternative — `gtm_message`, `relations_person` — and
they make the boundary a naming convention, which is to say nothing. A schema
makes it an object the database itself understands: permissions attach to it,
`DROP` removes exactly it, and a foreign key crossing it is visible in the
catalogue rather than inferred from a prefix.

Per-layer migrations matter for a reason that only shows up later: with one
journal, adding a domain renumbers everyone's migrations and two branches
adding a domain each conflict every time.

The direction of dependencies is checked by `scripts/check.mjs`, not reviewed.
A rule that depends on a reviewer noticing is a rule that holds until the week
someone is busy.

## Rules out

- Table prefixes in a shared schema.
- A sideways foreign key between two domains. A domain that needs to read
  another's data reads a published view; a domain that needs to extend
  another's entity adds its own table in its own schema.
- Relying on `search_path`. A transaction pooler does not carry it reliably and
  the failure is intermittent, which is the worst kind.

## Would reverse it

A hosting target with no support for schemas. Every serious Postgres host
supports them, so this is close to theoretical.
