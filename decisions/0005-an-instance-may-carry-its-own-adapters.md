# 0005 — An instance may carry its own adapters

Supersedes the second half of decision 0001's "no engine code" and amends
doctrine 8.

## Decided

An instance may hold adapters, in one place: `adapters/` at its root. It may
hold nothing else that is code — no domain logic, no schema, no migration, no
rule about who is targeted or suppressed.

A provider binding names its adapter the way Node resolves anything else. A
relative path is an adapter in this instance; a bare specifier is a published
package:

```yaml
providers:
  - contract: crm
    adapter: ./adapters/acme-crm.ts     # nobody else has this tool
    env: [ACME_CRM_TOKEN]
  - contract: sequencer
    adapter: "@werunfoundry/adapter-x"  # shipped by the kernel
    env: [X_API_KEY]
```

No new concept: the string's shape already means this everywhere else.

The instance runs a check, shipped by the kernel so that improvements reach
every instance through a version bump rather than a copy-paste. It refuses:

- any code outside `adapters/` and the declared entry scripts;
- an import of `@werunfoundry/*/db/schema`, or a declared `pgSchema` — an
  adapter that reaches into the database is not an adapter;
- a secret, by the same patterns the kernel uses on itself.

## Why

The rule it replaces made the engine unusable by anyone whose stack was not
anticipated. There is always a tool nobody foresaw, and requiring a merge into
a public repository the user does not own, before they may run the engine at
all, is not a boundary — it is a gate with one keyholder.

What decision 0001 was actually protecting against was the instance becoming a
fork: accumulating logic that should have been generic, invisibly, until the
second use case required a rewrite. That risk is real and unchanged. But the
criterion was wrong. The question is not *where the file lives*, it is *what
the file is allowed to be* — and an adapter is narrow by construction. It
satisfies a contract, it names one provider, it touches no table, it holds no
rule. All four are checkable, and a check is worth more than a prohibition
that people route around.

## What this costs, and it is not free

**The contracts become a published surface.** Today they can be changed freely
because nothing implements them; the first real adapter was expected to move
one or two of them. Once an instance implements `Sequencer`, changing
`Sequencer` breaks someone else's code.

While the kernel is `0.x`: contracts may change, an instance pins a kernel
version, and a contract change is called out. That is deliberately loose, and
it tightens when there is something to tighten.

**Adapters will be written twice.** Three instances will each write their own
adapter for the same well-known tool, worse than one good shared version. The
answer is cultural, not mechanical: an adapter that proves useful is
contributed up, and the kernel lists the ones that exist. A mechanism that
forced it would be the gate this decision just removed.

**The kernel's checks cannot see instance adapters.** They run in a repository
the kernel does not read. Hence the shipped instance check — weaker than
reviewing the code, stronger than hoping.

## Rules out

- An adapter anywhere in an instance other than `adapters/`.
- An instance adapter that reads or writes the database directly. It calls the
  outside world and returns a `CallResult`; the engine owns persistence.
- Business rules smuggled in as an adapter — the suppression decision, the
  targeting rule, the "skip this account" condition. Those belong to a domain,
  which is to say to the kernel, which is to say they are generic or they are
  not rules.

## What was considered

The problem was forced; this answer was not. Two alternatives were real.

**Published packages only.** Every adapter is an npm package, public or on a
private registry — one resolution mechanism, sharing as the default,
versioning for free. Rejected because publishing a package for a hundred and
fifty throwaway lines, and standing up a private registry for anything
proprietary, is heavy for a team of two. If instance-local adapters turn out
to breed copies faster than contribution fixes, this comes back.

**A plugin surface narrower than the contracts.** Instead of arbitrary
TypeScript, instances supply a declarative description — endpoint, auth, field
mapping — interpreted by the engine. Rejected because the interpreter must
anticipate every case before the first adapter works, and the cases it cannot
express (pagination that is not one of three shapes, telling "empty" from
"could not tell", a `withdraw` the provider has no concept of) are the ones
that matter. Every such format eventually grows a field holding an expression,
and then it is code in YAML: no types, no tests, no stack traces.

But rejecting it gave something up, and the record should say so: a narrow
declarative surface would have kept the contracts private and free to change.
The versioning obligation above exists *because* this option was refused.

## Would reverse it

Not the ability itself — that is forced. But the shape is revisitable, and the
trigger is specific: the first real adapter that shows a contract is badly cut.
If changing it is painful because instances already implement it, the narrow
declarative surface returns — beside code adapters, not in place of them, for
the providers that genuinely fit a description. That is a decision to take with
three or four adapters written, which is the earliest anyone can see what they
have in common.
