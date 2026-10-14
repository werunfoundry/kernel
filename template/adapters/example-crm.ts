/**
 * An adapter, in full, against an invented HTTP API.
 *
 * It is here to be read and copied, and it is here to be compiled: it is the
 * only implementation of a contract in this repository, so CI proves that the
 * contracts are implementable rather than merely well described.
 *
 * Nothing about `example.invalid` is real. Replace the four places marked
 * `CHANGE:` and the rest is mechanical.
 */

import type {
  AdapterFactory,
  CallContext,
  CallError,
  CallResult,
} from "@werunfoundry/core/contracts/types";
import type {
  Crm,
  CrmCompany,
  CrmLookup,
  CrmNote,
  CrmPerson,
  CrmRegistration,
  CrmRegistrationResult,
} from "@werunfoundry/relations/contracts/crm";

/* -------------------------------------------------------------------------- */
/* Turning HTTP into a CallResult                                              */
/* -------------------------------------------------------------------------- */

/**
 * The mapping below is the real work of an adapter, and the reason adapters
 * are code. `retryable` is not a property of a status code in the abstract:
 * 409 means "already exists" here and "try again" elsewhere, and getting it
 * wrong turns a duplicate into an infinite retry.
 */
function errorFor(status: number, body: string): CallError {
  if (status === 401 || status === 403) {
    return { code: "unauthorized", message: "rejected the credentials", retryable: false };
  }
  if (status === 404) {
    return { code: "not_found", message: "no such record", retryable: false };
  }
  if (status === 409) {
    return { code: "conflict", message: "already exists", retryable: false };
  }
  if (status === 422 || status === 400) {
    return { code: "invalid", message: body.slice(0, 200), retryable: false };
  }
  if (status === 429) {
    return { code: "rate_limited", message: "rate limited", retryable: true, retryAfterMs: 60_000 };
  }
  if (status >= 500) {
    return { code: "unavailable", message: `upstream ${status}`, retryable: true, retryAfterMs: 5_000 };
  }
  return { code: "unknown", message: `unexpected ${status}`, retryable: false, providerCode: String(status) };
}

/**
 * A network failure is `unavailable` and retryable; an abort is not, because
 * the caller asked for it and retrying would ignore them.
 */
function errorForThrown(thrown: unknown): CallError {
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

/* -------------------------------------------------------------------------- */

interface ApiRecord {
  id: string;
  url?: string;
  attributes?: Record<string, string | number | boolean | null>;
}

const factory: AdapterFactory<Crm> = ({ options, env }) => {
  // CHANGE: the variable name your binding declares in `env`.
  const token = env.EXAMPLE_CRM_TOKEN;
  // CHANGE: your provider's base URL, overridable per instance.
  const baseUrl = String(options.baseUrl ?? "https://api.example.invalid/v1");

  async function call<T>(
    path: string,
    init: RequestInit,
    ctx: CallContext,
  ): Promise<CallResult<T>> {
    if (!token) {
      // Fails the same way every other failure does, so a missing credential
      // is something a run can report rather than something that throws.
      return { ok: false, error: { code: "unauthorized", message: "EXAMPLE_CRM_TOKEN is not set", retryable: false } };
    }
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        headers: {
          ...init.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          // Carried so that a record can be traced back to the run that made it.
          "x-run-id": ctx.runId,
        },
      });
      if (!response.ok) {
        return { ok: false, error: errorFor(response.status, await response.text()) };
      }
      return { ok: true, value: (await response.json()) as T };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown) };
    }
  }

  const asCompany = (r: ApiRecord): CrmCompany => ({
    ref: r.url ? { externalId: r.id, url: r.url } : { externalId: r.id },
    ...(typeof r.attributes?.name === "string" ? { name: r.attributes.name } : {}),
    ...(typeof r.attributes?.domain === "string" ? { domain: r.attributes.domain } : {}),
    fields: r.attributes ?? {},
  });

  const asPerson = (r: ApiRecord): CrmPerson => ({
    ref: r.url ? { externalId: r.id, url: r.url } : { externalId: r.id },
    ...(typeof r.attributes?.email === "string" ? { email: r.attributes.email } : {}),
    ...(typeof r.attributes?.name === "string" ? { fullName: r.attributes.name } : {}),
    fields: r.attributes ?? {},
  });

  /**
   * A search that matched nothing is a success with `null`. Only a search that
   * could not be performed is an error — the distinction the whole fail-closed
   * story rests on.
   */
  async function findOne<T>(
    path: string,
    shape: (r: ApiRecord) => T,
    ctx: CallContext,
  ): Promise<CallResult<T | null>> {
    const found = await call<{ data: ApiRecord[] }>(path, { method: "GET" }, ctx);
    if (!found.ok) return found;
    const first = found.value.data[0];
    return { ok: true, value: first ? shape(first) : null };
  }

  return {
    // CHANGE: the one place in this repository a provider may be named.
    provider: "example-crm",

    /**
     * The cheapest authenticated read this API has. It asks whether the
     * provider answers and accepts the token — not what it holds — so the
     * domain is invented and the result is discarded.
     */
    async probe(ctx): Promise<CallResult<void>> {
      // CHANGE: your provider's cheapest authenticated read.
      const answered = await call<unknown>("/companies?domain=example.com", { method: "GET" }, ctx);
      return answered.ok ? { ok: true, value: undefined } : answered;
    },

    findCompanyByDomain(domain, ctx): Promise<CrmLookup<CrmCompany>> {
      return findOne(`/companies?domain=${encodeURIComponent(domain)}`, asCompany, ctx);
    },

    findPersonByEmail(email, ctx): Promise<CrmLookup<CrmPerson>> {
      return findOne(`/people?email=${encodeURIComponent(email)}`, asPerson, ctx);
    },

    async register(
      registration: CrmRegistration,
      ctx: CallContext,
    ): Promise<CallResult<CrmRegistrationResult>> {
      const email = registration.person.email;
      if (!email) {
        return { ok: false, error: { code: "invalid", message: "a person needs an email here", retryable: false } };
      }

      const existing = await this.findPersonByEmail(email, ctx);
      if (!existing.ok) return existing;
      if (existing.value) return { ok: true, value: { person: existing.value, existed: true } };

      if (ctx.dryRun) {
        // A dry run does every lookup and no write, and says which it was.
        return {
          ok: true,
          simulated: true,
          value: {
            person: { ref: { externalId: "(would be created)" }, email, fields: {} },
            existed: false,
          },
        };
      }

      const created = await call<ApiRecord>(
        "/people",
        {
          method: "POST",
          headers: {
            // The caller's key, not one invented here: the caller is the only
            // one that knows what "the same operation" means.
            "idempotency-key": registration.idempotencyKey,
          },
          body: JSON.stringify({
            email,
            name: registration.person.fullName,
            source: registration.reason,
            occurred_at: registration.occurredAt,
          }),
        },
        ctx,
      );
      if (!created.ok) return created;
      return { ok: true, value: { person: asPerson(created.value), existed: false } };
    },

    async annotate(note: CrmNote, ctx: CallContext): Promise<CallResult<void>> {
      if (ctx.dryRun) return { ok: true, simulated: true, value: undefined };
      const written = await call<unknown>(
        "/notes",
        {
          method: "POST",
          headers: { "idempotency-key": note.idempotencyKey },
          body: JSON.stringify({
            record_id: note.subject.externalId,
            body: note.body,
            occurred_at: note.occurredAt,
          }),
        },
        ctx,
      );
      return written.ok ? { ok: true, value: undefined } : written;
    },
  };
};

export default factory;
