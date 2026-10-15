/**
 * adapters/fullenrich — the relations `Enrichment` contract, against the
 * FullEnrich API (v2): work addresses and phone numbers for a person known by
 * their profile on a professional network.
 *
 *   - contract: enrichment
 *     adapter: "@werunfoundry/adapters/fullenrich"
 *     env: [FULLENRICH_API_KEY]
 *     finds: [email]                 # narrow it: a phone costs ten times an address
 *     options:
 *       network: linkedin            # the instance's name for the network; must be in its `networks`
 *       waitMs: 180000               # how long one completion waits for its job, in total
 *       pollMs: 10000                # how often it reads the job meanwhile
 *       timeoutMs: 30000             # one HTTP request
 *       jobPrefix: kernel            # the start of every job's name in the provider's dashboard
 *
 * Read in FullEnrich's published documentation and OpenAPI document, not
 * inferred, and not yet run against a real workspace.
 *
 * **Every completion is a paid submission.** Their enrichment is
 * asynchronous: a POST creates a named job in the workspace, visible in its
 * dashboard, and the answer is read from the job when it finishes. Credits
 * are spent when something is found — 1 for a work address, 10 for a mobile
 * phone. So a completion submits a job of one person, asking only for the
 * kinds it was asked for (`want`), waits for it within `waitMs`, and reads
 * it. Personal addresses are never asked for.
 *
 * **Nothing is ever submitted twice by this adapter, and nothing it returns
 * invites the engine to.** Every failure after the POST is `retryable:
 * false` and names the job — its id, and its name — because the credits it
 * spent are only recoverable by someone opening that job by hand. A POST
 * that times out may have created a job without returning its id; that
 * failure names the job by its name, and says so. Their API cannot find a
 * job by name, so the adapter cannot find it either.
 *
 * **When this is not enough.** It is enough while a person launches the run
 * and reads its report: a double payment is then visible, and small. The day
 * enrichment runs with nobody in front of it — on a schedule, from a queue —
 * a submission ledger becomes necessary before anything else: a row written
 * before each POST with the job's deterministic name, the job's id written
 * after it, and a replay that finds a row without an id refusing to submit
 * again. Without it, on a scheduler, a double payment is invisible and
 * repeats. It is the trigger, not the volume, that makes it necessary.
 *
 * The bulk endpoint takes up to 100 people per job. This adapter sends one,
 * because the contract completes one subject at a time; batching is a
 * contract change for the day the volume asks for it.
 *
 * What it returns, and what it deliberately does not:
 *
 * - **It needs the profile handle**, to build the profile URL. Given one, the
 *   provider returns the profile, and with it the network's numeric id —
 *   the immutable key 0022 needs. Without that id in the answer, the
 *   contract rejects the completion: a handle can change hands.
 * - **The URL's field name is the one thing the reference contradicts
 *   itself on** — `linkedin_url` in the schema, `professional_network_url`
 *   in one example. This sends the schema's, and the first real call
 *   settles it. A wrong name is safe by construction: the provider ignores
 *   it, its answer carries no profile, so no profile id, and the contract
 *   rejects every completion. A wrong name is a loud refusal, never a wrong
 *   key.
 * - **An address the provider marks `INVALID` or `INVALID_DOMAIN` is not
 *   returned.** The provider disavows it, so it does not attest it. Every
 *   other address is returned with the provider's status in `said` —
 *   `CATCH_ALL` included: undeliverable is not known, and whether to send is
 *   the sending policy's decision, not this adapter's.
 * - **A number the provider marks `INACTIVE`, or as belonging to someone
 *   else (`MISMATCH`), is not returned**, for the same reason. The others
 *   are returned as written, with their line type and status in `said`.
 * - **A dry run submits nothing.** The POST is a write — it creates a job
 *   and spends credits — so a dry run checks what it would send and returns
 *   `simulated`, which says nothing was learnt.
 */

import { createHash } from "node:crypto";

import type { AdapterFactory, CallContext, CallError, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity, IdentityKey } from "@werunfoundry/core/identity";

import type { Completion, Enrichment, KeyStatus } from "@werunfoundry/relations/contracts/enrichment";

interface Email {
  email?: string;
  status?: string;
}

interface Phone {
  number?: string;
  line_type?: string;
  line_status?: string;
  ownership_match?: string;
}

interface EnrichedRecord {
  contact_info?: { work_emails?: Email[]; phones?: Phone[] };
  profile?: { social_profiles?: { professional_network?: { id?: number; handle?: string } } };
}

interface Job {
  id?: string;
  name?: string;
  status?: string;
  data?: EnrichedRecord[];
  cost?: { credits?: number };
}

/** The kinds this adapter finds, and the field each one is asked for by. */
const FIELDS: { [kind: string]: string } = { email: "contact.work_emails", phone: "contact.phones" };

/** What the provider says to disavow a key. Such a key is not attested. */
const DISAVOWED_EMAIL = new Set(["INVALID", "INVALID_DOMAIN"]);

const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

/**
 * The status codes their reference documents: 400 (with a code), 401, 402
 * (credits), 404, 429. Before a job exists, a refusal is the request's; once
 * one does, see `afterSubmit`.
 */
function errorFor(status: number, body: string): CallError {
  let parsed: { code?: string; message?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    /* not JSON: the status says enough */
  }
  const detail = (parsed.message ?? body).slice(0, 200);
  const providerCode = parsed.code ?? String(status);
  if (status === 401 || status === 403) return { code: "unauthorized", message: "the API key was refused", retryable: false, providerCode };
  if (status === 402) return { code: "unauthorized", message: "the workspace has no credits left", retryable: false, providerCode };
  if (status === 404) return { code: "not_found", message: detail, retryable: false, providerCode };
  if (status === 400 || status === 422) return { code: "invalid", message: detail, retryable: false, providerCode };
  if (status === 429) return { code: "rate_limited", message: "rate limited", retryable: true, retryAfterMs: 60_000, providerCode };
  if (status >= 500) return { code: "unavailable", message: `upstream ${status}`, retryable: true, retryAfterMs: 5_000, providerCode };
  return { code: "unknown", message: `unexpected ${status}`, retryable: false, providerCode };
}

function errorForThrown(thrown: unknown, timeoutMs: number): CallError {
  if (thrown instanceof Error && thrown.name === "TimeoutError") {
    return { code: "unavailable", message: `no answer within ${timeoutMs} ms`, retryable: true, retryAfterMs: 5_000 };
  }
  if (thrown instanceof Error && thrown.name === "AbortError") return { code: "unavailable", message: "cancelled", retryable: false };
  return { code: "unavailable", message: thrown instanceof Error ? thrown.message : String(thrown), retryable: true, retryAfterMs: 5_000 };
}

const factory: AdapterFactory<Enrichment> = ({ options, env }) => {
  const token = env.FULLENRICH_API_KEY;
  const base = String(options.baseUrl ?? "https://app.fullenrich.com/api/v2").replace(/\/$/, "");
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 30_000;
  const waitMs = typeof options.waitMs === "number" ? options.waitMs : 180_000;
  const pollMs = typeof options.pollMs === "number" ? options.pollMs : 10_000;
  const network = String(options.network ?? "linkedin");
  const prefix = String(options.jobPrefix ?? "kernel");

  async function call<T>(method: "GET" | "POST", path: string, ctx: CallContext, body?: unknown): Promise<CallResult<{ status: number; body: T }>> {
    if (!token) return fail("unauthorized", "FULLENRICH_API_KEY is not set");
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      // 402 on a job read carries the job; 400 carries a code to read. Both
      // are returned to the caller as bodies, and turned into errors there.
      if (!response.ok && !(method === "GET" && (response.status === 400 || response.status === 402))) {
        return { ok: false, error: errorFor(response.status, text) };
      }
      return { ok: true, value: { status: response.status, body: (text ? JSON.parse(text) : undefined) as T } };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown, timeoutMs) };
    }
  }

  const key = (identity: Identity, kind: string) => identity.keys.find((k) => k.kind === kind && k.network === network)?.value.trim();

  /**
   * Once a job exists, every failure names it and is never retryable: the
   * identical call is a second paid submission, and whatever the first one
   * found is only recoverable by opening that job.
   */
  const afterSubmit = (job: { id: string; name: string }, code: CallError["code"], what: string, providerCode?: string): CallResult<never> =>
    fail(
      code,
      `${what} — job ${job.id} ("${job.name}") was submitted and may have spent credits; it is not submitted again: open it by hand`,
      false,
      providerCode ? { providerCode } : {},
    );

  const wait = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((done) => {
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
    });

  /** What a finished job's one record attests, and what the provider said about it. */
  function read(record: EnrichedRecord | undefined, asked: string[]): { attested: IdentityKey[]; said: KeyStatus[] } {
    const attested: IdentityKey[] = [];
    const said: KeyStatus[] = [];
    const profile = record?.profile?.social_profiles?.professional_network;
    if (typeof profile?.id === "number") attested.push({ kind: "social_profile_id", network, value: String(profile.id) });
    if (profile?.handle) attested.push({ kind: "social_profile_handle", network, value: profile.handle });
    if (asked.includes("email")) {
      for (const e of record?.contact_info?.work_emails ?? []) {
        const value = e.email?.trim().toLowerCase();
        if (!value || DISAVOWED_EMAIL.has(e.status ?? "")) continue;
        const k = { kind: "email", value };
        if (attested.some((a) => a.kind === "email" && a.value === value)) continue;
        attested.push(k);
        if (e.status) said.push({ key: k, status: e.status });
      }
    }
    if (asked.includes("phone")) {
      for (const p of record?.contact_info?.phones ?? []) {
        const value = p.number?.trim();
        if (!value || p.line_status === "INACTIVE" || p.ownership_match === "MISMATCH") continue;
        if (attested.some((a) => a.kind === "phone" && a.value === value)) continue;
        const k = { kind: "phone", value };
        attested.push(k);
        said.push({ key: k, status: `${p.line_type ?? "UNKNOWN"}/${p.line_status ?? "UNKNOWN"}` });
      }
    }
    return { attested, said };
  }

  return {
    provider: "fullenrich",
    finds: ["email", "phone"],

    /** `GET /account/keys/verify`: authenticated, and it spends no credit. */
    async probe(ctx): Promise<CallResult<void>> {
      const r = await call<unknown>("GET", "/account/keys/verify", ctx);
      if (!r.ok) return r;
      return r.value.status === 200 ? { ok: true, value: undefined } : { ok: false, error: errorFor(r.value.status, JSON.stringify(r.value.body ?? "")) };
    },

    async complete({ identity, want }, ctx): Promise<CallResult<Completion>> {
      if (identity.subject !== "person") return fail("invalid", "this adapter completes people only");
      const handle = key(identity, "social_profile_handle");
      if (!handle) return fail("invalid", `completing needs the person's ${network} profile handle: the provider is asked by profile URL, and only then returns the profile's id`);
      // A paid source is asked for named kinds only. Absent `want` would mean
      // "everything", and everything includes a phone at ten times the price.
      const asked = [...new Set(want ?? [])].filter((k) => FIELDS[k] !== undefined);
      if (asked.length === 0) return fail("invalid", `this adapter is asked for named kinds only, among ${Object.keys(FIELDS).join(", ")}; it was asked for ${want?.join(", ") || "nothing"}`);

      const digest = createHash("sha256").update([handle, ...asked.sort()].join("\n")).digest("hex").slice(0, 12);
      const name = `${prefix} ${ctx.runId} ${digest}`;
      const body = {
        name,
        data: [{ linkedin_url: `https://www.linkedin.com/in/${encodeURIComponent(handle)}/`, enrich_fields: asked.map((k) => FIELDS[k]) }],
      };
      // A dry run stops here: everything the submission needs was checked,
      // and the submission itself is a write.
      if (ctx.dryRun) return { ok: true, simulated: true, value: { found: false, asOf: new Date().toISOString() } };

      const submitted = await call<{ enrichment_id?: string }>("POST", "/contact/enrich/bulk", ctx, body);
      if (!submitted.ok) {
        const e = submitted.error;
        // No answer to a POST is not "not submitted": the job may exist.
        if (e.code === "unavailable") {
          return fail("unavailable", `${e.message} — the submission may have been accepted without its id coming back; look for the job named "${name}" by hand; it is not submitted again`, false);
        }
        return submitted;
      }
      const id = submitted.value.body?.enrichment_id;
      if (!id) return fail("unknown", `the submission was accepted without a job id; look for the job named "${name}" by hand; it is not submitted again`, false);
      const job = { id, name };

      const deadline = Date.now() + waitMs;
      for (;;) {
        const r = await call<Job & { code?: string; message?: string }>("GET", `/contact/enrich/bulk/${encodeURIComponent(id)}`, ctx);
        if (!r.ok) return afterSubmit(job, r.error.code, `the job could not be read (${r.error.message})`, r.error.providerCode);
        const read402 = r.value.status === 402;
        const b = r.value.body;
        if (r.value.status === 400 && b?.code !== "error.enrichment.in_progress") {
          return afterSubmit(job, "invalid", `the job was refused when read: ${b?.message ?? "no message"}`, b?.code);
        }
        const status = r.value.status === 400 ? "IN_PROGRESS" : (b?.status ?? "UNKNOWN");
        if (read402 || status === "CREDITS_INSUFFICIENT") return afterSubmit(job, "unauthorized", "the workspace ran out of credits during the job", "CREDITS_INSUFFICIENT");
        if (status === "FINISHED") {
          const cost = typeof b?.cost?.credits === "number" ? { cost: { amount: b.cost.credits, unit: "credits" } } : {};
          const records = b?.data ?? [];
          if (records.length !== 1) return afterSubmit(job, "unknown", `the job finished with ${records.length} records for one person`);
          const { attested, said } = read(records[0], asked);
          const asOf = new Date().toISOString();
          // Found means the provider identified the person: their profile, or
          // a key asked for. An answer with neither is "looked, found nothing".
          if (attested.length === 0) return { ok: true, value: { found: false, asOf, ...cost } };
          return { ok: true, value: { found: true, attested: { subject: "person", keys: attested }, asOf, ...(said.length ? { said } : {}), ...cost } };
        }
        if (status === "CANCELED" || status === "RATE_LIMIT" || status === "UNKNOWN") {
          return afterSubmit(job, status === "RATE_LIMIT" ? "rate_limited" : "unavailable", `the job ended as ${status}`, status);
        }
        // CREATED, IN_PROGRESS: still running.
        if (ctx.signal?.aborted) return afterSubmit(job, "unavailable", "cancelled while the job ran");
        if (Date.now() + pollMs > deadline) {
          return afterSubmit(job, "unavailable", `could not tell: the job was still running after ${waitMs} ms`, status);
        }
        await wait(pollMs, ctx.signal);
      }
    },
  };
};

export default factory;
