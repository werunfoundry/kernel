# 0073 — A merge publishes the commit it names

Completes [0025](0025-an-instance-consumes-what-is-published.md), which left
a published version as one of the two forms an instance consumes, and
[0008](0008-the-build-now-and-no-loader-anywhere.md), whose cost was that the
packages were not on the registry. Rests on
[0006](0006-the-published-artifact-is-javascript.md).

## What was found

On `main` at `81b2db8`. The five packages are versioned `0.1.0`, each
`publishConfig` says `access: public`, and nothing publishes them. None
names a repository. 0008, *What this costs*, "Not on the registry yet."
0025, *Decided*, names a published version as a form an instance may consume
"once the packages are on the registry", and the packed tarball as the form
before that.

The tarballs an instance was running were packed on 19 October and named
`gtm`. The name carries a version that does not move, and the domain's
former name. It does not carry the commit, so nothing in it said they
preceded 0046, and with it everything built since 0051.

## Decided

Every merge to main publishes five packages to the public registry:
`@werunfoundry/core`, `@werunfoundry/relations`, `@werunfoundry/acquisition`,
`@werunfoundry/api`, `@werunfoundry/adapters`. The template is not among
them. It publishes only once every gate of that same run has passed, on
the commit being published. The workflow's one job holds every gate — the
doctrine, its tests, the engine's tests, the packed instance, the
typecheck, the migrations, the advisories — and each runs on a push to
main, not only on a pull request. A version that failed its own tests
cannot be taken back.

The version is `0.1.0-main.g` and the first seven characters of the commit.
Seven, cut from the commit itself. Git's abbreviated revision grows when
seven characters stop being unique, and a re-run would then publish a
different string from the run it repeats. The version is applied as the
packages are published and is not committed: the tree stays at `0.1.0`.
`--no-git-checks` follows, because that pose leaves the tree dirty.

The `g` is the prefix `git describe` puts on a commit. A prerelease
identifier made only of digits is compared as a number, and the spec
forbids a leading zero, so a sha of seven characters that is all digits
and starts with `0` — `0123456` — is not a version npm will publish.
About one commit in 270, on no schedule, and the error will not say this.
The letter makes the identifier alphanumeric, and a leading zero is then
legal. It looks like noise. It is why a publish of that commit succeeds.
Checked against the semver npm 10.9.2 ships: `0.1.0-main.0123456` is
rejected, `0.1.0-main.g0123456` is accepted.

The dist-tag is `main`. `latest` is not moved. There is nothing to promise
under it yet. A semantic version comes when there is a promise to make;
until then the commit is what an instance pins, exactly.

The registry attests the link between the package and the commit that
produced it: `--provenance`, with `id-token: write`. The attestation is the
registry's, not a convention in a filename. Provenance checks the
published `repository` against the repository the workflow runs in. Each
of the five names `werunfoundry/kernel`, and the directory of that package
inside it. A missing field, or one that names another repository, fails
the publish.

Publication is `pnpm publish`. The packages depend on each other by
`workspace:`, and pnpm rewrites that to the version it is publishing.
`npm publish` uploads the protocol as it stands, and the dependency cannot
be installed.

A version is immutable. Publishing it again fails. A re-run of the same
commit finds each package already present and continues, and publishes each
that is absent. Any other failure — the registry unreachable, the token
refused — stops the run, and the output is kept.

**A sha is a version only when the five packages are on the registry at
it.** A run that publishes three and fails on the fourth has not published
that commit. The three are an incomplete set, and an instance that pinned
them would be running a mix no commit built. The re-run publishes what is
missing and leaves what is there; the sha becomes a version on the run
where the five are present, and not before. Until then it is not one an
instance can pin.

The first publication authenticates with a granular write token on the
scope. Trusted publishing is set per package, and a package has to exist
before it can be set. The token expires on 25 January 2027: the registry
caps a write token at 90 days, with no exception. The date is written in
the workflow, beside the secret it dates, which is where a failed publish
is read.

Trusted publishing is the state this moves to. It is not an option kept
open beside the token. Once the five exist, GitHub Actions authenticates
by OIDC, the workflow drops the token, and the token is revoked. A token
still in place on 25 January is this decision not carried out.

## What this changes for an instance

It declares `0.1.0-main.g<sha>` where it declared a path to a tarball.
`packs/` leaves its dependencies and its overrides. The lockfile says which
engine it runs: the version it resolved is the commit, and it is that
commit only when the five packages share the sha. The tarball remains the
way to try a change that has not merged (0025). No existing instance is
changed by this decision.

## What was considered

Publishing only when a path inside a package changes. Most merges change a
decision or a document and no package, and publishing them adds five
versions whose bytes match the five before. A path filter would drop that
noise. It gives up the property this decision exists for: any commit of
main is a version an instance can pin. A commit with no version is a commit
the instance cannot name. A shipped file left off the filter fails the same
way, and nothing says so.

Given up instead: a new version is not news that the engine changed. Most
will be the same bytes as the one before. Whether the engine moved is the
diff of the two commits.

## What this costs

Five versions on every merge, and a version is kept, because an instance
may be pinned to it. The registry accumulates one version per package per
merge, most of them identical to the previous artifact. Accepted: a version
that names the commit is what the tarball's name did not say.

A range does not install them. `^0.1.0` matches no prerelease. An instance
pins the exact version.

A write token with a date on it, for as long as the five do not yet exist
and trusted publishing has not replaced it.

## What this does not reach

The bytes the registry serves. `try-instance` installs the tarballs this
repository packs. Packing is what a publish uploads (0025). What the
registry stores, and what an install from it receives, is a further step,
and nothing in CI takes it. The first instance that installs these versions
from the registry is the test of that step.

An existing instance. Its dependencies stay as they are until someone
changes them there.

## Not built yet

Trusted publishing, on `main` at `81b2db8`. It cannot be configured until
the five packages exist, so this change publishes with the token. The
change once they do configures the trusted publisher for each, removes the
token from the workflow, and the token is revoked — before 25 January 2027.

## Rules out

- GitHub Packages. The repository is already public, so a public package
  reveals nothing the repository does not. Another registry would put a
  `.npmrc`, and an identifier in it, in every instance. An instance's
  identifiers are named in `.env` and live in no file.
- Moving `latest`.
- `npm publish`.
- Publishing the template.
- A version committed into the tree.
- A path filter on which merges publish.
- Treating a sha as a version while any of the five is missing at it.
- A prerelease identifier of digits alone. The `g` stays.
- Publishing a commit while a gate of that same run is not green. A green
  pull request is a different tree.

## Would reverse it

A promise worth a semantic version, and a `latest` that means that promise.
The commit-named versions remain the history of what was published. They
stop being the only pin.

The registry refusing the number of versions. A version would then mark a
release rather than a commit, and an arbitrary commit of main would no
longer be pinnable — the property given up above, taken back because the
registry forced it.
