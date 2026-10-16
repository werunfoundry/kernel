# 0044 — Protection matches a domain's ancestors, and fails closed on what is not a host

Completes [0028](0028-a-domain-is-compared-as-a-host.md), which compared a
domain as the host it names, and
[0033](0033-protection-matches-the-company-id-and-is-not-an-identity.md).

## Decided

**A candidate's domain matches a protected domain when its host, or any of
its ancestors, is one.** `app.11x.ai` is protected by `11x.ai`;
`x.dcx.ufpb.br` by `dcx.ufpb.br`. The walk drops the leftmost label one at a
time and stops at two labels. **The protected set does not move**: each
protected domain is compared as the host it names, as before (0028), never
widened to its registrable domain. A protected subdomain protects itself and
what is under it, not its parent: `dcx.ufpb.br` does not protect `ufpb.br`.
The same walk applies to the domain of a person's address.

**No public suffix list.** A list would only bound the walk at the
registrable domain. The protected set holds companies' domains, never a
public suffix, so the bound changes no verdict on it. Where it would — a
protected entry that is itself a suffix, or an exception rule of the list —
the unbounded walk excludes *more*, never less: it cannot open a blind
spot. A list would be a dependency, or a parser of wildcard and exception
rules written here, which is exactly what fails silently.

**The protected set is checked when it is read.** Every protected row whose
domain is not blank must name a host: at least two labels, each made of
letters, digits and inner hyphens. One that does not stops the run, naming
the row, as every other unreadable protected set does (doctrine 6). A
blank domain is still no domain.

**A candidate's domain that is not a host is excluded, for that reason.** A
value present but unreadable — an inner space, `www.www.…`, a link written in
Markdown, anything that is not a host once trimmed of its scheme, path, port
and one `www.` — could match nothing, and so passed. It is now excluded by
protection itself, under a reason of its own — `unreadable_key`, in sourcing
and in enrolment — unless another of its keys already protects it. Every
caller that asks whether a company is protected gets "yes" for it.

**Each run counts what each protected entry excluded.** For every protected
domain or company id that matched, the run reports how many distinct
candidates it excluded. An entry that starts excluding dozens is seen at
once, with no list and no recurring check: that is the guard on the
unbounded walk.

## Rules out

- Widening a protected domain to its registrable domain.
- A candidate whose key cannot be read passing as unprotected.
- A protected row with a domain that is not a host, read as if it were one.
- A public suffix list in the kernel, vendored or as a dependency.

## Would reverse it

A protected set that holds suffix-like entries on purpose — a platform's
zone protected as a whole — so that the walk's over-exclusion became the
norm rather than a visible accident. Then the walk needs its bound, and the
list with it.
