# 0054 — A declared capacity has a method behind it

> Not built, on `main` at `350656e`: the declaration's type still lets both
> pulls be served, `checkDeclaration` reads the declaration alone, and boot
> checks no declaration. Only the test double is held to its declaration
> (`170f4a2`).

Completes [0051](0051-a-sequencer-says-what-it-cannot-do-and-proves-what-it-did.md),
whose declaration is checked for its form and against nothing else.

## What was found

On `main` at `b56e19b`, and on the open pull request #94 at `9cd354a`.

- **`checkDeclaration` reads the declaration alone** (`sequencer.ts:260`).
  - Run, it raises no issue on a declaration that serves both pulls. The
    contract has no method for either.
  - It raises none either on a suspension whose measured gap gives "said
    so" as its basis.
  - `readDeclaration` then answers that the kernel may enrol.
- **`withdraw` is required of every sequencer** (`sequencer.ts:386`). The
  compiler guarantees that a method exists. It cannot say whether the method
  does what the declaration claims.
- **The kernel's own test double shows the gap.**
  - The memory sequencer of the enrolment tests declares that it suspends
    by parking the person (`enrol.test.ts:150`).
  - Its `withdraw` answers success and does nothing (`:177-179`). #94
    changes the answer to "not found", and it still does nothing.
  - This is the success that does nothing — what 0051 was written against
    — inside the suite that tests the refusal of it.

## Decided

**A verb is declared served only where the contract has a method for it.**
Enrolment has `enrol`. Suspension has `withdraw`: 0011 named the act so,
and 0051 calls it suspension. The two pulls have no method, so "not served"
is the only valid declaration for them. That is held in two places:

- in the declaration's type, so the compiler refuses anything else;
- in `checkDeclaration`, for an adapter the compiler never saw. An
  instance's adapter may be plain JavaScript: the instance check accepts
  `.js`, `.mjs` and `.cjs` (`check-instance.mjs:60`).

When a pull gains its method in the contract, it may be declared served.

**`checkDeclaration` reads the adapter, not the declaration alone.** A verb
declared served whose method is not a function on the adapter is refused.
The refusal comes at boot and before an enrolment, as a malformed
declaration is refused today.

**No check proves that a method works.** A method is proven per act, by the
read-back 0051 requires, and the kernel records that read-back. A
declaration is a precondition, never evidence. A measured gap still carries
its basis and its date (0051), and no check judges the basis.

**A test double is held to its declaration**: it does what it declares, or
it declares what it does. The memory sequencer has two ways to comply:

- remove the person from what it holds when it withdraws them, so that a
  test can see it;
- or declare that it cannot suspend, after which nothing can be enrolled
  through it.

This is enforced in review. No check sees behaviour.

**#94 meets the first two rules.** Its declaration serves both pulls
"no", and, run, its `withdraw` is a function. Its memory sequencer is the
double above.

## Rules out

- A verb declared served that the contract has no method for.
- A verb declared served whose method is not a function on the adapter.
- A test double that declares what it does not do.

## Would reverse it

A conformance run that each adapter makes against its provider, whose
recorded result the kernel can read. A declaration would then be checked
against what was observed, not against a method's presence.

## Not decided here

**The threshold.** A declaration that passes every check here still lets
the kernel enrol through a real provider. What holds that line is
[0055](0055-one-passage-reaches-a-person.md). Until 0055 is built, a
provisional guard holds it, and #94 merges behind that guard.
