# CLAUDE.md — kernel

Read this before taking any action in this repository. Then read `DOCTRINE.md`,
which is the design and is short.

## 0. This repository is public

Every commit is permanent and is crawled within minutes. There is no "I'll
clean it up in the next commit".

Four things you never write here, whatever the instruction:

1. **A brand, company, client or customer name.** Not in code, comments, commit
   messages, tests, fixtures or docs. If a request would require one, the
   request belongs in the instance repository, not here — say so.
2. **A secret.** No key, token, connection string or password, not even a
   placeholder that looks real. `.env.example` carries variable names and
   nothing else.
3. **Real data.** Fixtures are invented: `example.com`, `example.org`,
   `*.invalid`. Never a real profile URL, never a real company.
4. **A provider name outside its adapter.** Nothing under `core/` or
   `domains/` names a vendor, except inside an `adapters/` directory.

If you are unsure whether something is identifying, it is. Leave it out and ask.

## 1. Before proposing a commit

```bash
node scripts/check.mjs
```

It is dependency-free and takes a second. Every failure names the doctrine rule
it comes from. Do not propose a commit that has not passed it.

It checks secrets, fixtures, provider names and — rule 2 — that every import
and every foreign key between layers is one the importing domain declared in
its `domain.yaml`. A dependency you did not declare does not compile past it.

Never commit on `main`. Branch first: `git switch -c <type>/<short-name>`, with
`feat/`, `fix/`, `docs/`, `chore/` or `ci/`. The pre-commit hook enforces both,
once `git config core.hooksPath .githooks` has been run on the clone.

## 2. How to work here

- **File names are lowercase, and multi-word names take a dash**:
  `target-list.ts`, never `targetList.ts`. Exported names are camelCase for
  values and PascalCase for types, as TypeScript expects.
- **Read before writing.** The existing file is the convention. This repository
  prefers consistency over cleverness.
- **Plan visibly** for anything past a couple of steps, and end with a
  verification: run the checks, re-read the diff, run the tests.
- **Ask first** on anything that changes a boundary — a new core object, a new
  dependency between domains, a new package. Those are doctrine decisions, not
  implementation details.
- **Dependencies are a decision.** Do not add one without asking. The checks
  and the hook are deliberately dependency-free.
- **Reasoning goes in the file**, as a comment next to the thing it explains —
  not into a separate document that will drift from it. Every index names the
  query it serves; every unique says which write path it protects.

## 3. The boundaries that matter

If you remember nothing else from the doctrine:

- The core contains no business word.
- Dependencies point down. A foreign key never goes sideways or upward.
- When two domains need the same concept, it moves down, not sideways.
- Uniqueness keys live in the DDL, never in the caller.
- A fact this system does not own is read, never copied.
- Attribution is three columns — `actorType`, `actorId`, `runId` — not an
  identity system.

## 4. Decisions

A decision that changes a boundary gets a file in `decisions/`, numbered, with
what was decided, what it rules out, and what would reverse it. One page. A
decision taken only in a conversation does not exist.
