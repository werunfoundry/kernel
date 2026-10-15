/**
 * adapters/instantly — the Sequencer contract, against Instantly's API v2.
 *
 * Every claim below about how Instantly behaves was read in its published
 * OpenAPI document (api.instantly.ai/openapi/api_v2.json) or its help centre,
 * not inferred. Where a behaviour is documented but has not been observed
 * against a live workspace, the comment says so.
 *
 * Binding, in an instance manifest:
 *
 *   - contract: sequencer
 *     adapter: "@werunfoundry/adapters/instantly"
 *     env: [INSTANTLY_API_KEY]
 *     options:
 *       campaign.<sequenceKey>: <Instantly campaign id>   # one per sequence
 *
 * How the contract maps, and where it does not:
 *
 * - **A sequence is a campaign**, and a person in a sequence is a *lead* —
 *   one lead record per person per campaign. Instantly identifies a person by
 *   email; a lead id names one enrolment, not a person, so `externalId` is not
 *   used to find people.
 * - **No idempotency key.** Nothing in the API accepts one. Instantly's own
 *   sameness is one lead per email per campaign: `/leads/add` reports a lead
 *   already in that campaign as `duplicated_leads` and does not re-add it. The
 *   caller's key is stored on the lead as a custom variable, so a replay is
 *   recognised as the same enrolment and a different key on the same person
 *   and campaign is reported as `conflict` (see the contract).
 * - **The sender is the campaign's.** Instantly rotates across the accounts a
 *   campaign lists; a lead cannot be pinned to one. An explicit sender is
 *   refused rather than accepted and ignored.
 * - **withdraw deletes the lead from that campaign.** A lead's status is
 *   read-only in the API, so there is no pause or stop for one lead. Deleting
 *   is synchronous and stops the sequence; it also removes Instantly's record
 *   of that enrolment — its status and counters.
 * - **suppress is the workspace blocklist**, which takes an email or a whole
 *   domain and, per Instantly's help centre, is checked "across ongoing
 *   campaigns" as well as at upload. Workspace-wide: it stops every campaign,
 *   and refuses the address in future uploads.
 * - **One channel, `email`** (decision 0014). A person is reached by the
 *   `email` key of their identity; an identity without one is refused.
 *   `suppress` applies an identity's `email` keys and, for a company, its
 *   `domain` keys, and reports every other key as one it cannot act on.
 * - **Capacity is per account**: its `daily_limit`, and what it sent today
 *   from the daily account analytics. A campaign may also cap sending
 *   (`daily_limit`, `daily_max_leads`); the contract has no place for that.
 */

import type {
  AdapterFactory,
  CallContext,
  CallError,
  CallResult,
} from "@werunfoundry/core/contracts/types";

import type { Identity, IdentityKey } from "@werunfoundry/core/identity";

import type {
  Capacity,
  Enrolment,
  EnrolmentState,
  EnrolmentStatus,
  Sequencer,
  Suppression,
} from "@werunfoundry/gtm/contracts/sequencer";

/* -------------------------------------------------------------------------- */
/* What the API returns, as far as this adapter reads it                       */
/* -------------------------------------------------------------------------- */

interface Lead {
  id: string;
  email?: string | null;
  campaign?: string | null;
  /** Read-only. 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed, -3 skipped. */
  status?: number;
  payload?: Record<string, unknown> | null;
  timestamp_updated?: string;
}

interface Page<T> {
  items: T[];
  next_starting_after?: string;
}

interface BulkAdd {
  leads_uploaded?: number;
  in_blocklist?: number;
  duplicated_leads?: number;
  skipped_count?: number;
  invalid_email_count?: number;
  created_leads?: { index: number; id: string; email?: string }[];
}

interface Account {
  email: string;
  daily_limit?: number | null;
  /** 1 active, 2 paused, 3 maintenance, -1 connection error, -2 soft bounce, -3 sending error. */
  status?: number;
}

interface DailyAccountAnalytics {
  date: string;
  email_account: string;
  sent: number;
}

/** Custom-variable names this adapter writes on a lead. Namespaced, so they read as ours. */
const KEY = "engine_idempotency_key";
const RUN = "engine_run_id";
const EXPERIMENT = "engine_experiment";
const VARIANT = "engine_variant";

const STATES: Record<number, EnrolmentState> = {
  1: "active",
  2: "paused",
  3: "finished",
  [-1]: "bounced",
  [-2]: "unsubscribed",
  // Skipped: Instantly decided not to send — the blocklist, a per-company
  // limit. The sequence will not reach this person.
  [-3]: "stopped",
};

/* -------------------------------------------------------------------------- */
/* HTTP to CallResult                                                          */
/* -------------------------------------------------------------------------- */

const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

/**
 * The status codes the API documents for every endpoint: 400, 401, 402, 404,
 * 429. The rate limit is per workspace, shared by every key and by API v1
 * (100 requests a second, 6,000 a minute); no `Retry-After` is documented, so
 * the wait suggested here is a guess sized to the per-second limit.
 */
function errorFor(status: number, body: string): CallError {
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

function errorForThrown(thrown: unknown, timeoutMs: number): CallError {
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

const today = () => new Date().toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */

const factory: AdapterFactory<Sequencer> = ({ options, env }) => {
  const token = env.INSTANTLY_API_KEY;
  const baseUrl = String(options.baseUrl ?? "https://api.instantly.ai").replace(/\/$/, "");
  // Every request has a deadline, overridable per binding: a provider that
  // stops answering becomes an error, not a run that never ends.
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000;

  /** `campaign.<sequenceKey>` in the binding's options. */
  const campaignFor = (sequenceKey: string): string | undefined => {
    const id = options[`campaign.${sequenceKey}`];
    return typeof id === "string" && id !== "" ? id : undefined;
  };
  const unmapped = (sequenceKey: string) =>
    fail("invalid", `no campaign is mapped to the sequence "${sequenceKey}": add the option campaign.${sequenceKey}`);

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
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
  }

  /** The lead for this email in this campaign, or null. Emails compare without case. */
  async function findLead(email: string, campaign: string, ctx: CallContext): Promise<CallResult<Lead | null>> {
    const found = await call<Page<Lead>>("POST", "/api/v2/leads/list", ctx, {
      campaign,
      contacts: [email],
      limit: 10,
    });
    if (!found.ok) return found;
    const wanted = email.toLowerCase();
    const lead = found.value.items.find((l) => (l.email ?? "").toLowerCase() === wanted && (l.campaign ?? campaign) === campaign);
    return { ok: true, value: lead ?? null };
  }

  const statusOf = (lead: Lead, sequenceKey: string): EnrolmentStatus => ({
    state: (lead.status !== undefined ? STATES[lead.status] : undefined) ?? "unknown",
    sequenceKey,
    asOf: lead.timestamp_updated ?? new Date().toISOString(),
  });

  /** A lead that exists already: the same enrolment if it carries our key, a conflict otherwise. */
  function existing(lead: Lead, enrolment: Enrolment): CallResult<EnrolmentStatus> {
    const key = lead.payload?.[KEY];
    if (key === enrolment.idempotencyKey) return { ok: true, value: statusOf(lead, enrolment.sequenceKey) };
    return fail(
      "conflict",
      key === undefined
        ? "this person is already in that campaign, enrolled outside this engine"
        : "this person is already in that campaign under another idempotency key",
    );
  }

  /** The first `email` key: how Instantly reaches a person. */
  const emailOf = (person: Identity): string | undefined =>
    person.keys.find((k) => k.kind === "email" && k.value.trim() !== "")?.value.trim().toLowerCase();
  const offChannel = (channel: string) =>
    fail("invalid", `this adapter serves the channel "email" only, not "${channel}"`);
  const noEmail = () => fail("invalid", "Instantly reaches a person by email; this identity has no email key");

  const nameParts = (fullName?: string) => {
    const [first, ...rest] = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
    return { ...(first ? { first_name: first } : {}), ...(rest.length ? { last_name: rest.join(" ") } : {}) };
  };

  return {
    provider: "instantly",
    channels: ["email"],

    /**
     * Listing one campaign: the cheapest authenticated read, and one that
     * needs a scope this adapter needs anyway (`campaigns:read`). The
     * workspace endpoint would be cheaper still, but needs a scope the
     * adapter otherwise never uses — a key cut to what the adapter needs would
     * fail the probe and work for everything else.
     */
    async probe(ctx): Promise<CallResult<void>> {
      const listed = await call<Page<unknown>>("GET", "/api/v2/campaigns?limit=1", ctx);
      return listed.ok ? { ok: true, value: undefined } : listed;
    },

    async enrol(enrolment, ctx): Promise<CallResult<EnrolmentStatus>> {
      const campaign = campaignFor(enrolment.sequenceKey);
      if (!campaign) return unmapped(enrolment.sequenceKey);
      if (enrolment.channel !== "email") return offChannel(enrolment.channel);
      if (enrolment.sender) {
        return fail("invalid", "Instantly chooses the sender from the campaign's accounts; enrol without a sender");
      }
      const email = emailOf(enrolment.person);
      if (!email) return noEmail();

      const found = await findLead(email, campaign, ctx);
      if (!found.ok) return found;
      if (found.value) return existing(found.value, enrolment);

      if (ctx.dryRun) {
        // Every read the real call depends on, and no write: the campaign
        // must exist, and the person must not be blocklisted — the upload
        // would skip them.
        const camp = await call<{ status?: number }>("GET", `/api/v2/campaigns/${encodeURIComponent(campaign)}`, ctx);
        if (!camp.ok) return camp;
        const blocked = await isBlocked(email, ctx);
        if (!blocked.ok) return blocked;
        if (blocked.value) return fail("invalid", "this person is on the workspace blocklist; the upload would skip them");
        return {
          ok: true,
          simulated: true,
          value: { state: camp.value.status === 1 ? "active" : "paused", sequenceKey: enrolment.sequenceKey, asOf: new Date().toISOString() },
        };
      }

      const variables: Record<string, string> = {
        ...enrolment.variables,
        [KEY]: enrolment.idempotencyKey,
        [RUN]: enrolment.attribution?.runId ?? ctx.runId,
        ...(enrolment.attribution?.experimentSlug ? { [EXPERIMENT]: enrolment.attribution.experimentSlug } : {}),
        ...(enrolment.attribution?.variant ? { [VARIANT]: enrolment.attribution.variant } : {}),
      };
      const added = await call<BulkAdd>("POST", "/api/v2/leads/add", ctx, {
        campaign_id: campaign,
        leads: [{ email, ...nameParts(enrolment.display?.fullName), custom_variables: variables }],
      });
      if (!added.ok) return added;

      if ((added.value.in_blocklist ?? 0) > 0) {
        return fail("invalid", "this person is on the workspace blocklist; Instantly skipped them");
      }
      if ((added.value.invalid_email_count ?? 0) > 0) return fail("invalid", "Instantly refused the address as invalid");
      if ((added.value.duplicated_leads ?? 0) > 0) {
        // Someone enrolled them between our read and our write — possibly a
        // replay of this very call. Read again and decide by the key.
        const again = await findLead(email, campaign, ctx);
        if (!again.ok) return again;
        if (again.value) return existing(again.value, enrolment);
        return fail("unknown", "Instantly reported a duplicate it then could not find");
      }
      if ((added.value.leads_uploaded ?? 0) !== 1) {
        return fail("unknown", `Instantly did not create the lead: ${JSON.stringify(added.value).slice(0, 200)}`);
      }
      return { ok: true, value: { state: "active", sequenceKey: enrolment.sequenceKey, asOf: new Date().toISOString() } };
    },

    async withdraw(request, ctx): Promise<CallResult<void>> {
      const campaign = campaignFor(request.sequenceKey);
      if (!campaign) return unmapped(request.sequenceKey);
      const email = emailOf(request.person);
      if (!email) return noEmail();

      const found = await findLead(email, campaign, ctx);
      if (!found.ok) return found;
      if (!found.value) return { ok: true, value: undefined }; // not enrolled: already withdrawn
      if (ctx.dryRun) return { ok: true, simulated: true, value: undefined };

      const deleted = await call<unknown>("DELETE", `/api/v2/leads/${encodeURIComponent(found.value.id)}`, ctx);
      if (!deleted.ok && deleted.error.code === "not_found") return { ok: true, value: undefined };
      return deleted.ok ? { ok: true, value: undefined } : deleted;
    },

    async suppress(request, ctx): Promise<CallResult<Suppression>> {
      // Instantly's blocklist takes a full address, or a bare domain —
      // `example.com`, not `@example.com` — which blocks a whole account.
      // Every other key — a profile id, a company id — is one this provider
      // cannot act on, and is reported as such.
      const actionable: { key: IdentityKey; value: string }[] = [];
      const notApplicable: IdentityKey[] = [];
      for (const key of request.target.keys) {
        const value = key.kind === "email" ? key.value.trim().toLowerCase()
          : key.kind === "domain" ? key.value.trim().toLowerCase().replace(/^@/, "")
          : "";
        if (value) actionable.push({ key, value });
        else notApplicable.push(key);
      }
      if (actionable.length === 0) {
        return fail("invalid", "none of this identity's keys is an email or a domain, which is all Instantly can block");
      }

      const applied: IdentityKey[] = [];
      for (const { key, value } of actionable) {
        const blocked = await isBlocked(value, ctx);
        if (!blocked.ok) return blocked;
        if (!blocked.value && !ctx.dryRun) {
          const created = await call<unknown>("POST", "/api/v2/block-lists-entries", ctx, { bl_value: value });
          if (!created.ok) return created;
        }
        applied.push(key);
      }
      return { ok: true, ...(ctx.dryRun ? { simulated: true } : {}), value: { applied, notApplicable } };
    },

    async status(request, ctx): Promise<CallResult<EnrolmentStatus>> {
      const campaign = campaignFor(request.sequenceKey);
      if (!campaign) return unmapped(request.sequenceKey);
      const email = emailOf(request.person);
      if (!email) return noEmail();

      const found = await findLead(email, campaign, ctx);
      if (!found.ok) return found;
      if (!found.value) {
        return { ok: true, value: { state: "unknown", sequenceKey: request.sequenceKey, asOf: new Date().toISOString() } };
      }
      return { ok: true, value: statusOf(found.value, request.sequenceKey) };
    },

    async capacity({ sender, channel }, ctx): Promise<CallResult<Capacity>> {
      if (channel !== "email") return offChannel(channel);
      const email = encodeURIComponent(sender.externalId);
      const account = await call<Account>("GET", `/api/v2/accounts/${email}`, ctx);
      if (!account.ok) return account;

      // The date is UTC. The API does not say which day boundary its daily
      // analytics use; until that is observed, "today" may be off by the
      // workspace's offset near midnight.
      const day = today();
      const daily = await call<DailyAccountAnalytics[]>(
        "GET",
        `/api/v2/accounts/analytics/daily?emails=${email}&start_date=${day}&end_date=${day}`,
        ctx,
      );
      if (!daily.ok) return daily;

      const sent = daily.value
        .filter((d) => d.date === day && d.email_account.toLowerCase() === sender.externalId.toLowerCase())
        .reduce((n, d) => n + (d.sent ?? 0), 0);
      const limit = account.value.daily_limit ?? undefined;
      // An account that is not active sends nothing today, whatever its limit.
      const sending = account.value.status === 1;
      return {
        ok: true,
        value: {
          sender,
          channel,
          // One limit is all the API states for a sending account. Its day
          // boundary is not documented, so no `resetsAt` is claimed.
          limits: [
            {
              unit: "messages",
              window: "day",
              ...(limit !== undefined ? { limit } : {}),
              used: sent,
              ...(limit !== undefined ? { remaining: sending ? Math.max(0, limit - sent) : 0 } : {}),
            },
          ],
          asOf: new Date().toISOString(),
        },
      };
    },
  };

  /**
   * Whether an address or a domain is on the workspace blocklist. An address
   * is blocked by its own entry or by its domain's, and the API's search
   * matches one value at a time, so an address takes two reads.
   */
  async function isBlocked(value: string, ctx: CallContext): Promise<CallResult<boolean>> {
    const wanted = value.toLowerCase();
    const candidates = wanted.includes("@") ? [wanted, wanted.split("@")[1] ?? ""] : [wanted];
    for (const candidate of candidates.filter(Boolean)) {
      const listed = await call<Page<{ bl_value: string }>>(
        "GET",
        `/api/v2/block-lists-entries?search=${encodeURIComponent(candidate)}&limit=50`,
        ctx,
      );
      if (!listed.ok) return listed;
      if (listed.value.items.some((e) => e.bl_value.toLowerCase() === candidate)) return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }
};

export default factory;
