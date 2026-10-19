# 0028 — A domain is compared as the host it names

> Completed by [0044](0044-protection-matches-a-domains-ancestors-and-fails-closed.md):
> a protected domain also protects its subdomains, and a domain that is not a
> host is excluded.

Completes [0013](0013-an-identity-is-a-set-of-keys.md), whose keys were
compared trimmed and, where case means nothing, lower-cased.

## Decided

A key kind may declare `hostname: true` in a domain's `identityKeys`: its
value names a host on the web. `relations` declares it for `domain`.

Such a key is compared as `hostOf` in `core/identity` leaves it: lower case,
without a scheme, credentials or a leading `@`, without `www.`, a port, a
path, a query or a trailing dot. `http://WWW.Example.com:443/about` and
`example.com` are one key. A subdomain other than `www` is kept.

`normalizeIdentity` applies it. The enrolment path compares domains with it —
candidates, protected accounts, and the domain of a person's address — and
looks a company's people up by its host. `recordCompany` records and finds a
company by it. A value with no host left in it — `http://`, a blank — is no
domain: a protected account with nothing else to match stops the run, as an
account with no domain does, and a candidate with none is unreachable.

## Why

The first real target list wrote 278 of its 433 domains as something other
than a bare host: `Meetz.ai`, `http://Jobot.com`. The protected set, from
another source, wrote them bare. Protection compared the two lower-cased, so a
company written as a URL on one side and bare on the other would have been
enrolled while protected. Nothing was lost on that run — no candidate was
protected, however written — but the comparison was a hole, and the data
showed it is the common case, not an edge.

Matching more widely is the safe direction: a protected company spelled two
ways is still protected.

## Where, and why not elsewhere

The rule is the core's mechanism, the word is the domain's: the core does not
know what a company's domain is, `relations` says its key is a host, as it
already said it is case-blind. An adapter could clean its own values, and a
second adapter would clean them differently; the comparison is the engine's,
so the normal form is too.

## Rules out

- Comparing a domain as raw text.
- A protected account counted as matchable on a "domain" that names no host.
- Stripping subdomains other than `www`.

## Would reverse it

A key whose hosts differ by scheme or path for real — two companies at
`example.com/a` and `example.com/b`. That is not a domain any more, and would
be its own kind.
