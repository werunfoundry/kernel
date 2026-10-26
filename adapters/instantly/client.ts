/**
 * adapters/instantly — the HTTP client and the authentication both Instantly
 * adapters share: the sequencer, in `index.ts`, and the sequencer's mailbox,
 * in `inbound/` (the acquisition `Inbound` contract). One folder per
 * provider, whatever the number of contracts it satisfies.
 */

import type { CallContext, CallError, CallResult } from "@werunfoundry/core/contracts/types";

/** A page of a list, as every list endpoint of the API v2 returns it. */
export interface Page<T> {
  items: T[];
  next_starting_after?: string;
}

/* -------------------------------------------------------------------------- */
/* HTTP to CallResult                                                          */
/* -------------------------------------------------------------------------- */

export const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

/**
 * The status codes the API documents for every endpoint: 400, 401, 402, 404,
 * 429. The rate limit is per workspace, shared by every key and by API v1
 * (100 requests a second, 6,000 a minute); no `Retry-After` is documented, so
 * the wait suggested here is a guess sized to the per-second limit.
 */
export function errorFor(status: number, body: string): CallError {
  const detail = body.slice(0, 200);
  if (status === 401) return { code: "unauthorized", message: "the API key was refused", retryable: false };
  if (status === 403) return { code: "unauthorized", message: `the API key lacks a scope: ${detail}`, retryable: false };
  if (status === 402) {
    return { code: "unauthorized", message: "the workspace has no active paid plan", retryable: false, providerCode: "402" };
  }
  if (status === 404) return { code: "not_found", message: "no such record", retryable: false };
  if (status === 400 || status === 422) return { code: "invalid", message: detail, retryable: false };
  if (status === 429) return { code: "rate_limited", message: "workspace rate limit", retryable: true, retryAfterMs: 1_000 };
  if (status >= 500) return { code: "unavailable", message: `upstream ${status}`, retryable: true, retryAfterMs: 5_000 };
  return { code: "unknown", message: `unexpected ${status}`, retryable: false, providerCode: String(status) };
}

export function errorForThrown(thrown: unknown, timeoutMs: number): CallError {
  // The request's own deadline: the provider did not answer in time. Retryable,
  // and said in words — a run must not wait for ever on a silent provider.
  if (thrown instanceof Error && thrown.name === "TimeoutError") {
    return { code: "unavailable", message: `no answer within ${timeoutMs} ms`, retryable: true, retryAfterMs: 5_000 };
  }
  if (thrown instanceof Error && thrown.name === "AbortError") {
    return { code: "unavailable", message: "cancelled", retryable: false };
  }
  return {
    code: "unavailable",
    message: thrown instanceof Error ? thrown.message : String(thrown),
    retryable: true,
    retryAfterMs: 5_000,
  };
}

/** One request, as a `CallResult`: every request has a deadline, and every failure a code. */
export function client({ token, baseUrl, timeoutMs }: { token: string | undefined; baseUrl: string; timeoutMs: number }) {
  return async function call<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    ctx: CallContext,
    body?: unknown,
  ): Promise<CallResult<T>> {
    if (!token) return fail("unauthorized", "INSTANTLY_API_KEY is not set");
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: errorFor(response.status, text) };
      return { ok: true, value: (text ? JSON.parse(text) : undefined) as T };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown, timeoutMs) };
    }
  };
}
