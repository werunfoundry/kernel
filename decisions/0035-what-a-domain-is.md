# 0035 — What a domain is

## Decided

**A domain is a set of verbs on the record, plus the objects only those
verbs touch.** Never a team, never a function on an org chart. Two teams
that perform the same verbs are one domain. A new domain exists when it
brings verbs the record has never seen, carrying objects no other domain
needs.

**The membership test for an object is who owns the fact, not who reads
it.** An object moves down when its fact would be true even if the domain
that maintains it did not exist. It stays in its domain, behind a view that
domain publishes, when it only makes sense inside that domain's motion.

"This person is a customer" is true whether or not anyone is prospecting: it
moves down. "This person is at the opportunity stage" does not exist without
the motion that tracks a sales funnel: it stays, with a view if another
domain wants to consult it.

**The core is a record of work, in five parts** — who acted, what is being
tried, what ran, what was observed, what was concluded. The first is
attribution, carried by every row (doctrine 5); the other four are the
core's objects: experiment, run, event, decision. **It is not a record of
people.** People are a domain.

**A channel is not a domain**: it tells means apart within the same verbs.
**A domain may depend on no other.**

Written into `DOCTRINE.md`, section 1, in place of "a domain holds a line of
business".

## Why

The doctrine said how domains relate — dependencies point down, a shared
concept moves down — but not what makes something a domain. "A line of
business" is read as a department, and a department is the wrong cut: two
teams doing the same thing would get two domains and the same objects twice,
and a team's reorganisation would become a schema migration. Every split
since the first one was argued from case to case. This is the rule they
were all applying, written down so the next one is argued from it.

Verbs are what the record can check. An object belongs where the verbs that
touch it are. Doctrine 2 already offered two ways for a second domain to use
it — the object moves down, or its owner publishes a view — and nothing said
which to choose. Who reads cannot decide it, since every useful object is
read by someone. Who owns the fact can: a fact that outlives the domain
maintaining it is shared, and shared things move down; a fact that is only a
state of one domain's motion stays there, and others consult it through its
view. A channel changes how a verb is carried out, not which verb it is, so
it is vocabulary inside a domain, as `channels` already is.

## Rules out

- A domain per team, per department, or per role.
- A domain per channel.
- People, companies or any other subject in the core.
- A fact true without its domain kept in that domain.
- A state of one domain's motion moved down because another domain reads it.
- A domain created for objects another domain already needs.

## Would reverse it

A set of verbs that cannot be told apart from another domain's except by who
performs them — and that must still be kept apart, for access or for
retention. That would make the boundary an organisational one after all, and
the reason would have to be written down.
