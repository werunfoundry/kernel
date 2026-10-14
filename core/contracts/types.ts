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
}

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
