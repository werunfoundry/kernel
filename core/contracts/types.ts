/**
 * core/contracts — the machinery a contract is made of, and nothing about
 * any particular capability.
 *
 * A contract is what the engine requires of the outside world; an adapter is
 * one way of satisfying it, and the one place a provider may be named
 * (doctrine 6). Contracts for business capabilities belong to the domain that
 * needs them — a CRM is not a core concern.
 *
 * Two conventions hold for every contract, and both exist because the alternative
 * has already cost something:
 *
 *   - **Writes are idempotent or they are not writes.** Every write takes an
 *     idempotency key supplied by the caller, because the caller is the one
 *     that knows what "the same operation" means.
 *   - **Every call carries context**, so that a run is traceable and a dry run
 *     is a property of the call rather than a flag someone forgets.
 */

/** Who is acting, under which run, and whether anything may actually happen. */
export interface CallContext {
  runId: string;
  actor: { type: "human" | "agent" | "system"; id?: string };
  /**
   * When true, an adapter performs every read and validation it would
   * normally perform, and no write. It returns what it *would* have done.
   * Never a no-op that returns success without looking.
   */
  dryRun: boolean;
  /** Abort cooperatively. Long adapter calls must honour it. */
  signal?: AbortSignal;
}

export type CallErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "unknown";

export interface CallError {
  code: CallErrorCode;
  message: string;
  /** Whether retrying the identical call can succeed. */
  retryable: boolean;
  retryAfterMs?: number;
  /** The provider's own code, for the log. Never shown to a caller as truth. */
  providerCode?: string;
}

/**
 * Results are returned, not thrown.
 *
 * An exception means a programming error; a failed call is an expected
 * outcome and the caller must decide what it means. Suppression failing
 * closed depends on the caller being able to see the difference between
 * "empty" and "could not tell" — which a thrown error hides and a result
 * makes explicit.
 */
export type CallResult<T> =
  | { ok: true; value: T; /** True when a dry run stopped before the write. */ simulated?: boolean }
  | { ok: false; error: CallError };

/** Every adapter names itself, once, for logs and for the run record. */
export interface Contract {
  readonly provider: string;

  /**
   * Can the provider be reached, and does it accept these credentials? The
   * cheapest call that answers both, and nothing more (decision 0009).
   *
   * Optional, on purpose: requiring it would make every adapter write a
   * health check, and an adapter that has no honest one would write a
   * dishonest one. Absent means "not probed", which a caller reports as such —
   * never as healthy.
   *
   * Always a read, whatever `ctx.dryRun` says. A probe that writes is not a
   * probe. Success carries nothing: what the provider holds is not the
   * question, and an answer like "authenticated as …" is a detail a log
   * should not be handed.
   */
  probe?(ctx: CallContext): Promise<CallResult<void>>;
}

/* -------------------------------------------------------------------------- */
/* How an adapter comes into existence                                         */
/* -------------------------------------------------------------------------- */

/**
 * Environment variables, by name. An adapter receives the ones its binding
 * declared and nothing else, so a misconfigured instance fails at startup
 * rather than at the first call — and so that reading an adapter tells you
 * exactly which credentials it can reach.
 */
export type AdapterEnv = Readonly<Record<string, string | undefined>>;

export interface AdapterInit {
  /** The binding's `options`, passed through untouched. */
  options: Readonly<Record<string, string | number | boolean>>;
  /** Only the variables the binding named in `env`. */
  env: AdapterEnv;
}

/**
 * Every adapter module's default export.
 *
 * A factory and not a class, and not an already-built object: the engine must
 * be able to construct an adapter from a manifest it reads at startup, and a
 * module that builds itself at import time cannot be given configuration — it
 * reads `process.env` instead, which is how credentials end up somewhere no
 * manifest declares them.
 *
 * It is synchronous. An adapter that needs to reach the network before it can
 * exist is an adapter that fails at import, where no `CallResult` can carry
 * the reason; connect lazily on the first call instead.
 */
export type AdapterFactory<T extends Contract> = (init: AdapterInit) => T;

/* -------------------------------------------------------------------------- */
/* Metrics — read on demand, never stored as a series (doctrine 3)             */
/* -------------------------------------------------------------------------- */

export interface MetricQuery {
  /** Declared in the manifest, not invented at the call site. */
  key: string;
  params?: Record<string, string | number | boolean>;
  window?: { from: string; to: string };
}

export interface MetricReading {
  key: string;
  value: number;
  unit?: string;
  /** When the source computed it, not when we asked. */
  asOf: string;
  source: string;
}

/**
 * A source of numbers. The engine keeps none of them except inside a
 * decision's snapshot, which is why this contract has no write side and no
 * history method: there is nowhere here for a series to go.
 */
export interface MetricSource extends Contract {
  read(query: MetricQuery, ctx: CallContext): Promise<CallResult<MetricReading>>;
}
