/**
 * adapters/attio — the HTTP client and the authentication both Attio
 * adapters share: `crm/` (the relations `Crm` contract) and `inbound/` (the
 * gtm `Inbound` contract). One folder per provider, whatever the number of
 * contracts it satisfies.
 *
 * Read in Attio's published OpenAPI document (api.attio.com/openapi/api) and
 * its rate-limiting guide, not inferred:
 *
 * - Bearer token. A workspace access token is enough for both adapters.
 * - Errors: 400 invalid, 403 missing scope, 404 not found, 409 conflict.
 *   401 is not listed in the document and is handled anyway.
 * - Rate limits are 100 reads and 25 writes a second. A limited request is
 *   always 429, with a `Retry-After` that is an HTTP **date**, not a number of
 *   seconds.
 */

import type { CallContext, CallError, CallResult } from "@werunfoundry/core/contracts/types";

export const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

/** Milliseconds until an HTTP date, or undefined when there is none to read. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function errorFor(status: number, body: string, retryAfter: string | null): CallError {
  const detail = body.slice(0, 200);
  if (status === 401) return { code: "unauthorized", message: "the API token was refused", retryable: false };
  if (status === 403) return { code: "unauthorized", message: `the token lacks a scope: ${detail}`, retryable: false };
  if (status === 404) return { code: "not_found", message: "no such record", retryable: false };
  if (status === 409) return { code: "conflict", message: detail, retryable: false };
  if (status === 400 || status === 413 || status === 422) return { code: "invalid", message: detail, retryable: false };
  if (status === 429) {
    const wait = retryAfterMs(retryAfter);
    return { code: "rate_limited", message: "rate limited", retryable: true, ...(wait !== undefined ? { retryAfterMs: wait } : {}) };
  }
  if (status >= 500) return { code: "unavailable", message: `upstream ${status}`, retryable: true, retryAfterMs: 5_000 };
  return { code: "unknown", message: `unexpected ${status}`, retryable: false, providerCode: String(status) };
}

function errorForThrown(thrown: unknown, timeoutMs: number): CallError {
  if (thrown instanceof Error && thrown.name === "TimeoutError") {
    return { code: "unavailable", message: `no answer within ${timeoutMs} ms`, retryable: true, retryAfterMs: 5_000 };
  }
  if (thrown instanceof Error && thrown.name === "AbortError") return { code: "unavailable", message: "cancelled", retryable: false };
  return { code: "unavailable", message: thrown instanceof Error ? thrown.message : String(thrown), retryable: true, retryAfterMs: 5_000 };
}

export type Call = <T>(method: "GET" | "POST" | "PUT", path: string, ctx: CallContext, body?: unknown) => Promise<CallResult<T>>;

/**
 * A client bound to one token and one base URL. Every request of both
 * adapters goes through it, and every request has a deadline: a provider that
 * never answers must become an error, not a run that never ends.
 */
export function client(
  token: string | undefined,
  baseUrl: string,
  timeoutMs = 30_000,
): { call: Call; probe: (ctx: CallContext) => Promise<CallResult<void>> } {
  const base = baseUrl.replace(/\/$/, "");
  const call: Call = async (method, path, ctx, body) => {
    if (!token) return fail("unauthorized", "ATTIO_API_KEY is not set");
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${base}${path}`, {
        method,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: errorFor(response.status, text, response.headers.get("retry-after")) };
      return { ok: true, value: (text ? JSON.parse(text) : undefined) as never };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown, timeoutMs) };
    }
  };

  /**
   * `GET /v2/self`: the cheapest authenticated read, and it answers the
   * probe's question exactly. A token that is valid but no longer active
   * answers 200 with `active: false`, which is a refusal, not health.
   */
  const probe = async (ctx: CallContext): Promise<CallResult<void>> => {
    const self = await call<{ active?: boolean }>("GET", "/v2/self", ctx);
    if (!self.ok) return self;
    if (self.value?.active !== true) return fail("unauthorized", "the token is not active");
    return { ok: true, value: undefined };
  };

  return { call, probe };
}

export const DEFAULT_BASE_URL = "https://api.attio.com";
