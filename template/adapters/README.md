# Adapters

An adapter satisfies one contract by talking to one provider. This is the only
place in an instance where code lives (doctrine 8, decision 0005).

`example-crm.ts` is a complete one, against an invented API. Copy it, change
the four places marked `CHANGE:`, and point a binding at it.

## What an adapter is not

The check that runs here refuses all three, because each is a domain written
in the wrong repository:

- **It does not touch the database.** No import of a schema, no `pgSchema`. It
  calls the outside world and returns a `CallResult`; the engine owns what is
  persisted and when.
- **It holds no rule.** Not who to contact, not who to skip, not when a
  sequence stops. Those are the same for every instance or they are not rules,
  and the engine is where they go.
- **It does not read `process.env` itself.** It receives exactly the variables
  its binding declared. A credential an adapter reaches for without the
  manifest naming it is a credential nothing audits.

## Shape

The default export is a factory: the engine builds the adapter from the
manifest at startup, so a module that configures itself at import time cannot
be configured at all.

```ts
const factory: AdapterFactory<Crm> = ({ options, env }) => ({ /* … */ });
export default factory;
```

Offer a `probe` if the provider has a cheap authenticated read: `pnpm verify`
calls it to tell a working configuration from a plausible one (decision
0009). It is optional. Leave it out rather than write one that returns
success without asking the provider — absent is reported as absent, and a
probe that always succeeds is reported as health.

Build nothing in the factory that can fail. Connect on the first call, where a
failure can be returned as a `CallError` instead of thrown where no run can
report it.
