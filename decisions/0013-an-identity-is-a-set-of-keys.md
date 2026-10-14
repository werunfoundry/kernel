# 0013 — An identity is a set of keys

## Decided

An identity is one subject and the keys that name it in the systems that name
it: `{ subject, keys: [{ kind, value, network? }] }`. It lives in
`core/identity/`, as a type and pure functions — no table, no lookup, no
resolution.

**The core holds the mechanism, the domains hold the words.** Which subjects
exist and which kinds of key name them are declared in `domain.yaml`, under
`identityKeys`, the way channels are. `relations`, which owns people and
companies, declares four: `email` and `social_profile_id` for a person,
`domain` and `social_company_id` for a company. A kind is declared by one
enabled domain only; two declaring it is refused at boot.

**Each kind says whether it is immutable.** A profile or company id on a
network, once issued, names the same subject for ever. An address and a domain
do not: an address is reissued, a domain is sold.

**Immutable keys are authoritative.** `compareIdentities` returns one of four
answers, with the evidence:

- `conflict` — an immutable key of the same kind and network differs. They
  are two subjects, whatever else they share, including an address.
- `same_immutable` — they share an immutable key, and none conflicts.
- `same_mutable` — they share only mutable keys: evidence, not proof.
  Protection treats it as the same subject, because over-protecting is the
  safe mistake. Nothing merges on it.
- `unknown` — no key in common, or different subjects.

**When only one key is known**, the identity carries one key. Nothing is
inferred from it. An operation that needs a kind the identity lacks — an email
sequencer handed only a profile id — refuses rather than guessing, and
completing an identity is a job for a contract (enrichment), not for this
type.

**Networks are declared by the instance**, in `manifest.yaml` under
`networks`, and validated as identifiers. A networked key whose network is not
declared is refused. Without this, two adapters writing one network two ways
would leave two identities that never meet again.

## Why here, and why not more

The brief was to put the identity in the core. Taken literally — a person and
a company in the core, and keys called after a social network — it breaks two
rules:

- **Doctrine 1**, "the core contains no business word". People and companies
  are `relations`' objects.
- **Doctrine 6**, a provider is named only inside its adapter. A key called
  after a network names that network's provider.

What moves down is the mechanism. **Doctrine 2**, "when two domains need the
same concept, it moves down", is the argument for it: `gtm` needs identities to
suppress, and `relations` owns the subjects. A generic set of typed keys is
that shared concept. "Person" stays where it was. The core stays at four tables
and five enums: this adds a type, not an object.

Declaring networks in a domain was considered and refused: it would have put a
network's name in a `domain.yaml`, which doctrine 6 forbids. The instance is
private, and naming a provider there is its business.

The check that enforces doctrine 6 gained that network's name in its list, and
lost a hole on the way. It bounded names with `\b`, which treats `_` as a
letter, so a provider's name inside an identifier — `<provider>_profile_id`,
`<provider>_id` — passed.

## Rules out

- A person, a company, or a network name in the core.
- A key kind declared by two domains.
- A networked key on an undeclared network.
- Merging two identities on a mutable key.

## Would reverse it

A subject that needs more than keys to be told apart — two people who share
every key and are still different. That is identity resolution, and it would
need a table and a decision of its own. The relations schema already says the
first backfill decides when that is needed.
