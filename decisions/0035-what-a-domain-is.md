# 0035 — What a domain is

## Decided

**A domain is a set of verbs on the record, plus the objects only those
verbs touch.** Never a team, never a function on an org chart. Two teams
that perform the same verbs are one domain. A new domain exists when it
brings verbs the record has never seen, carrying objects no other domain
needs.

**The membership test for an object: would a second domain want to read
it?** If so, it moves down. If not, it stays.

**The core is a record of work** — who acted, what ran, what was observed,
what was concluded — **not a record of people.** People are a domain.

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
touch it are; an object a second domain needs to read is, by that need,
shared, and shared things move down (doctrine 2). A channel changes how a
verb is carried out, not which verb it is, so it is vocabulary inside a
domain, as `channels` already is.

## Rules out

- A domain per team, per department, or per role.
- A domain per channel.
- People, companies or any other subject in the core.
- An object read by two domains staying in one of them.
- A domain created for objects another domain already needs.

## Would reverse it

A set of verbs that cannot be told apart from another domain's except by who
performs them — and that must still be kept apart, for access or for
retention. That would make the boundary an organisational one after all, and
the reason would have to be written down.
