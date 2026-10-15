/**
 * adapters/edges — the relations `Enrichment` contract, against the
 * Edges API.
 *
 *   - contract: enrichment
 *     adapter: "@werunfoundry/adapters/edges"
 *     env: [EDGES_API_KEY]
 *     options:
 *       network: linkedin            # the instance's name for the network; must be in its `networks`
 *       identityIds: "<uuid>,<uuid>" # Edges identities that run the actions; else identityMode
 *       identityMode: auto           # auto | managed (managed costs extra credits)
 *
 * Read in Edges' published documentation and OpenAPI document, not inferred.
 * Edges runs actions on a social network through identities — accounts
 * connected to the workspace — and this adapter only uses the synchronous
 * (`live`) form of two of them.
 *
 * What it does, and what it deliberately does not:
 *
 * - **`peopleAt` takes an attested company id, never a domain.** It needs the
 *   company's id on the network (`social_company_id`). Edges can find a
 *   company page from a domain, but by its own description it "uses AI to
 *   find" it: a guess, which decision 0016 refuses as a key. A company known
 *   only by its domain is refused as `invalid`. Until a target list carries a
 *   company's social key, this adapter cannot serve the enrolment path — that
 *   is intended, not an oversight.
 * - **An empty page is "could not tell", never "nobody".** Edges documents
 *   that a page may hold fewer results than asked "in some cases like
 *   throttling". An empty page therefore cannot be told apart from a page the
 *   network withheld, and is returned as an error, never as an empty result.
 * - **People come back with the keys the network attests**: the profile's
 *   numeric id (immutable, `social_profile_id`) and its handle (mutable,
 *   `social_profile_handle`). Never an address.
 * - **`complete` finds an address only where the network shows one.** It
 *   reads a profile's contact details, which the network shows only to
 *   accounts it lets see them — in practice, direct connections — within
 *   Edges' quota of 250 lookups a day per identity. It needs the profile's
 *   handle, because every synchronous profile action takes a profile URL, and
 *   a URL is built from the handle, not from the numeric id. No address shown
 *   is `found: false`. A handle can be released and taken by someone else,
 *   so an answer that does not name the profile id is not accepted by the
 *   contract (0022) — the adapter reports it as the provider gave it. Bulk
 *   address enrichment exists at Edges only as an asynchronous action, which
 *   this synchronous contract does not use.
 */

import type { AdapterFactory, CallContext, CallError, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey } from "@werunfoundry/core/identity";

import type { Completion, Enrichment, FoundPerson, PeoplePage } from "@werunfoundry/relations/contracts/enrichment";

interface Employee {
  linkedin_profile_id?: number;
  linkedin_profile_handle?: string;
  full_name?: string;
  job_title?: string;
  current_title?: string;
}

interface Contact {
  email?: string;
  linkedin_profile_id?: number;
  linkedin_profile_handle?: string;
}

const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * The status codes Edges documents for its actions: 400, 402, 422, 424, 429,
 * 503. 424 is "failed dependency" — the identity running the action could not
 * reach the network, which is "could not look", never an answer.
 */
function errorFor(status: number, body: string, retryAfter: string | null): CallError {
  let parsed: { message?: string; error?: { details?: Record<string, string> } } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    /* not JSON: the status says enough */
  }
  const detail = (parsed.message ?? body).slice(0, 200);
  if (status === 401 || status === 403) return { code: "unauthorized", message: "the API key was refused", retryable: false };
  if (status === 402) return { code: "unauthorized", message: "the workspace has no credits left", retryable: false, providerCode: "402" };
  if (status === 404) return { code: "not_found", message: "no such record", retryable: false };
  if (status === 400 || status === 422) return { code: "invalid", message: detail, retryable: false };
  if (status === 424) return { code: "unavailable", message: `the identity running the action failed: ${detail}`, retryable: false, providerCode: "424" };
  if (status === 429) {
    const wait = retryAfterMs(retryAfter ?? parsed.error?.details?.["Retry-After"]);
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

/** `X-Pagination-Next` may be a cursor or a URL carrying one; only the cursor is kept. */
function cursorOf(header: string | null): string | undefined {
  if (!header) return undefined;
  if (!/^https?:\/\//.test(header)) return header;
  return new URL(header).searchParams.get("cursor") ?? undefined;
}

const factory: AdapterFactory<Enrichment> = ({ options, env }) => {
  const token = env.EDGES_API_KEY;
  const base = String(options.baseUrl ?? "https://api.edges.run/v1").replace(/\/$/, "");
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000;
  const network = String(options.network ?? "linkedin");
  const identityIds = String(options.identityIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const runAs = identityIds.length > 0 ? { identity_ids: identityIds } : { identity_mode: String(options.identityMode ?? "auto") };

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    ctx: CallContext,
    body?: unknown,
  ): Promise<CallResult<{ body: T; next: string | undefined }>> {
    if (!token) return fail("unauthorized", "EDGES_API_KEY is not set");
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { "x-api-key": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: errorFor(response.status, text, response.headers.get("retry-after")) };
      return { ok: true, value: { body: (text ? JSON.parse(text) : undefined) as T, next: cursorOf(response.headers.get("x-pagination-next")) } };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown, timeoutMs) };
    }
  }

  const key = (identity: Identity, kind: string) => identity.keys.find((k) => k.kind === kind && k.network === network)?.value.trim();

  const keysOf = (p: { linkedin_profile_id?: number; linkedin_profile_handle?: string }): IdentityKey[] => [
    ...(p.linkedin_profile_id !== undefined ? [{ kind: "social_profile_id", network, value: String(p.linkedin_profile_id) }] : []),
    ...(p.linkedin_profile_handle ? [{ kind: "social_profile_handle", network, value: p.linkedin_profile_handle }] : []),
  ];

  return {
    provider: "edges",

    /** `GET /workspaces`: authenticated, and it spends no credit. */
    async probe(ctx): Promise<CallResult<void>> {
      const r = await call<unknown>("GET", "/workspaces", ctx);
      return r.ok ? { ok: true, value: undefined } : r;
    },

    async peopleAt({ company, limit, cursor, params }, ctx): Promise<CallResult<PeoplePage>> {
      if (company.subject !== "company") return fail("invalid", "peopleAt takes a company");
      const companyId = key(company, "social_company_id");
      if (!companyId) {
        return fail("invalid", `this adapter finds people only from a company's ${network} id; a domain alone would mean guessing the company`);
      }
      if (!/^\d+$/.test(companyId)) return fail("invalid", "a company id on this network is a number");

      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const r = await call<{ items?: Employee[] } | Employee[]>("POST", `/actions/linkedin-search-company-employees/run/live${query}`, ctx, {
        input: { linkedin_company_url: `https://www.linkedin.com/company/${companyId}/`, linkedin_company_id: Number(companyId) },
        ...(params && Object.keys(params).length ? { parameters: params } : {}),
        ...runAs,
      });
      if (!r.ok) return r;
      const raw = Array.isArray(r.value.body) ? r.value.body : (r.value.body?.items ?? []);
      const items: FoundPerson[] = raw
        .map((e): FoundPerson | undefined => {
          const keys = keysOf(e);
          if (!keys.some((k) => k.kind === "social_profile_id")) return undefined; // no attested id: not identifiable
          const title = e.job_title ?? e.current_title;
          return {
            identity: { subject: "person", keys },
            display: { ...(e.full_name ? { fullName: e.full_name } : {}), ...(title ? { title } : {}) },
          };
        })
        .filter((x): x is FoundPerson => x !== undefined)
        .slice(0, limit ?? raw.length);
      // Edges says a page can be short when throttled. An empty one cannot be
      // told from a withheld one, so it is not reported as "nobody".
      if (items.length === 0) {
        return fail("unavailable", "an empty page from this provider may be throttling, so it cannot say there is nobody", true, { retryAfterMs: 60_000 });
      }
      return { ok: true, value: { items, ...(r.value.next ? { nextCursor: r.value.next } : {}), asOf: new Date().toISOString() } };
    },

    async complete({ identity }, ctx): Promise<CallResult<Completion>> {
      if (identity.subject !== "person") return fail("invalid", "this adapter completes people only");
      const handle = key(identity, "social_profile_handle");
      if (!handle) return fail("invalid", `completing needs the person's ${network} profile handle: every synchronous profile action takes a profile URL`);

      const r = await call<Contact>("POST", "/actions/linkedin-extract-contact/run/live", ctx, {
        input: { linkedin_profile_url: `https://www.linkedin.com/in/${encodeURIComponent(handle)}/` },
        ...(identityIds.length > 0 ? { identity_ids: identityIds } : {}),
      });
      if (!r.ok) return r;
      const asOf = new Date().toISOString();
      const email = r.value.body?.email?.trim().toLowerCase();
      if (!email) return { ok: true, value: { found: false, asOf } }; // looked; no address shown to this account

      // Only what the answer carries (decision 0022). The lookup was built from
      // a handle, which can have changed hands; the profile id the answer
      // names, if any, is the only thing tying it to the person asked about,
      // so the id from the request is never copied in to stand for it.
      const attested = [...keysOf(r.value.body), { kind: "email", value: email }];
      return { ok: true, value: { found: true, attested: { subject: "person", keys: attested }, asOf } };
    },
  };
};

export default factory;
