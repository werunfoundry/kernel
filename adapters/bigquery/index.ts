/**
 * adapters/bigquery — the gtm `TargetList` contract, read from BigQuery
 * tables.
 *
 *   - contract: target_list
 *     adapter: "@werunfoundry/adapters/bigquery"
 *     env: [BIGQUERY_SERVICE_ACCOUNT]      # a service account's JSON key; or [BIGQUERY_ACCESS_TOKEN]
 *     options:
 *       project: <project the queries run and are billed in>
 *       dataset: <dataset of the tables, unless a table names its own>
 *       network: <the instance's name for the network the company ids are on>
 *       candidates.table: <table>          # or dataset.table, or project.dataset.table
 *       candidates.statusColumn: <column>
 *       candidates.status: <value>         # the status a candidate has; a query's `status` param overrides it
 *       candidates.domainColumn: <column>
 *       candidates.companyIdColumn: <column>   # optional: the company's id on `network`
 *       candidates.idColumn: <column>      # optional: the table's own identifier
 *       candidates.nameColumn: <column>    # optional
 *       candidates.extractedAtColumn: <column>
 *       protected.table: <table>
 *       protected.activeColumn: <column>
 *       protected.activeValues: "<value>,<value>"   # a BOOLEAN column: true
 *       protected.domainColumn: <column>
 *       protected.idColumn: <column>       # optional; see "Two tables" below
 *       protected.nameColumn: <column>     # optional
 *       protected.extractedAtColumn: <column>
 *       protected.reason: customer         # optional, the default
 *       maximumBytesBilled: 1000000000     # optional: every query refuses to bill more
 *       location: EU                       # optional: where the jobs run
 *
 * Nothing about any company's warehouse is written here: every table and
 * every column is the binding's. Names are validated as identifiers before
 * they reach SQL, and every value — a status, the active values — is a query
 * parameter, never text in the query.
 *
 * Read in BigQuery's published REST reference (`jobs.query`,
 * `jobs.getQueryResults`, the error reasons) — not yet run against a live
 * project:
 *
 * - **A query is one job, and its pages are that job's.** `jobs.query` runs
 *   the query and returns a first page; `jobs.getQueryResults` returns the
 *   next ones, by page token. The cursor this adapter hands out names the
 *   job, so every page of one read comes from one result: a table rewritten
 *   between two pages cannot splice two versions of the protected set.
 * - **Values come back as strings.** Every selected column is cast to
 *   STRING, so a status that is a boolean or a number compares the same way,
 *   and nothing here interprets a type.
 * - **`errors` may hold warnings** on a job that succeeded. A complete job is
 *   trusted only with a schema; without one it failed, whatever it says.
 * - **Read-only by construction.** A service account's token asks for the
 *   `bigquery.readonly` scope, which both methods accept. Nothing here writes.
 *
 * **Every compared column is cast to STRING first**, so a value is never
 * text compared against another type. A BOOLEAN casts to "true" or "false"
 * (the published conversion rules), so `protected.activeValues: true` reads a
 * boolean active column, and `TRUE` is refused. A NULL casts to NULL and
 * equals no value — so the protected query also returns every row whose
 * active column is NULL, and one such row stops the read: an unknown
 * subscription is not an absent one (doctrine 6, 0009), and the run stops
 * rather than protecting less in silence. Same columns, same scan.
 *
 * Two tables, because the protected set is not a subset of the candidates
 * (see the contract): the customer accounts are read from their own table,
 * filtered on an active value, never from a status column on the target
 * table — an account that never was a target would be protected nowhere.
 * `externalId` is matched across the two routes (decision 0019), so the two
 * `idColumn` options must name companies in one identifier space, or be left
 * out: two spaces compared as one protect the wrong accounts.
 *
 * Fail closed, everywhere:
 *
 * - A missing or malformed option, or credentials in neither or both forms,
 *   refuse every call before anything is sent.
 * - **Freshness is the oldest extraction** in the route's table by default.
 *   A row with no extraction time makes the age unknown, which is an error.
 *   `<route>.freshness: newest` reads the latest instead, for a table loaded
 *   incrementally whose untouched rows are not stale — weaker, and chosen in
 *   the manifest where it can be read.
 * - **An empty protected set is an error**, unless the binding says
 *   `protected.allowEmpty: true`. A misspelt active value matches nothing,
 *   and nothing is what an unprotected run looks like.
 * - A result that ends short of the row count it announced is an error, and
 *   so is a page that cannot be continued.
 *
 * What each query reads — BigQuery bills the columns a query references, over
 * every row of the table, whatever the filter (10 MB minimum per table):
 *
 * - `freshness`: the extraction column of one table. The row count is
 *   metadata and reads nothing.
 * - `candidates`: the status, domain, and optional id, company id and name
 *   columns of the target table. Every page after the first is read from the
 *   job's result, not the table.
 * - `protectedAccounts`: the active, domain, and optional id and name columns
 *   of the customer table. Over a view, that is whatever the view computes:
 *   see this folder's README before scheduling it.
 * - `probe`: both freshness queries as dry runs, which bill nothing.
 */

import { createSign } from "node:crypto";

import type { AdapterFactory, CallContext, CallError, CallResult } from "@werunfoundry/core/contracts/types";
import type { Identity } from "@werunfoundry/core/identity";

import type {
  ProtectedAccount,
  ProtectionReason,
  TargetCompany,
  TargetList,
  TargetListFreshness,
  TargetPage,
  TargetQuery,
  TargetRoute,
} from "@werunfoundry/gtm/contracts/target-list";

/* -------------------------------------------------------------------------- */
/* What the API returns, as far as this adapter reads it                       */
/* -------------------------------------------------------------------------- */

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  schema?: { fields?: { name: string }[] };
  rows?: { f: { v: string | null }[] }[];
  /** UInt64 as a string. */
  totalRows?: string;
  pageToken?: string;
  errors?: { reason?: string; message?: string }[];
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

type Row = Record<string, string | null>;

const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const PAGE = 1_000;
const MAX_PAGE = 10_000;

const fail = (code: CallError["code"], message: string, retryable = false, extra: Partial<CallError> = {}) =>
  ({ ok: false, error: { code, message, retryable, ...extra } }) as const;

/* -------------------------------------------------------------------------- */
/* Configuration, read once from the binding                                   */
/* -------------------------------------------------------------------------- */

const PROJECT = /^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET = /^[A-Za-z0-9_]{1,1024}$/;
const TABLE = /^[A-Za-z0-9_-]{1,1024}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;
const REASONS: readonly ProtectionReason[] = ["customer", "open_opportunity", "partner", "do_not_contact", "other"];

interface RouteConfig {
  table: string;
  extractedAt: string;
  freshness: "oldest" | "newest";
  domain: string;
  id?: string;
  name?: string;
}

interface Config {
  project: string;
  location?: string;
  maximumBytesBilled?: string;
  network?: string;
  candidates: RouteConfig & { statusColumn: string; status?: string; companyId?: string };
  protected: RouteConfig & { activeColumn: string; activeValues: string[]; reason: ProtectionReason; allowEmpty: boolean };
}

/** Every problem with the binding's options, or the configuration they describe. */
function configure(options: Readonly<Record<string, string | number | boolean>>): Config | { problems: string[] } {
  const problems: string[] = [];
  const text = (key: string): string | undefined => {
    const value = options[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${key} must be a non-empty string`);
      return undefined;
    }
    return value.trim();
  };
  const required = (key: string): string => {
    const value = text(key);
    if (value === undefined && options[key] === undefined) problems.push(`${key} is required`);
    return value ?? "";
  };
  /** A value compared as text: YAML reads `1` and `true` as a number and a boolean, and the column is cast to STRING. */
  const scalar = (key: string): string | undefined => {
    const value = options[key];
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return text(key);
  };
  const column = (key: string, need: boolean): string | undefined => {
    const value = need ? required(key) : text(key);
    if (value !== undefined && value !== "" && !COLUMN.test(value)) problems.push(`${key} is not a column name: "${value}"`);
    return value || undefined;
  };

  const project = required("project");
  if (project && !PROJECT.test(project)) problems.push(`project is not a project id: "${project}"`);
  const dataset = text("dataset");
  if (dataset && !DATASET.test(dataset)) problems.push(`dataset is not a dataset id: "${dataset}"`);

  /** `table`, `dataset.table` or `project.dataset.table`, each part checked, quoted for SQL. */
  const table = (key: string): string => {
    const value = required(key);
    if (!value) return "";
    const parts = value.split(".");
    const [p, d, t] =
      parts.length === 3 ? parts : parts.length === 2 ? [project, parts[0], parts[1]] : [project, dataset, parts[0]];
    if (parts.length > 3 || !t || !TABLE.test(t)) problems.push(`${key} is not a table name: "${value}"`);
    else if (!d) problems.push(`${key} names no dataset, and no dataset option is set`);
    else if (!DATASET.test(d)) problems.push(`${key} names a dataset that is not a dataset id: "${d}"`);
    else if (!p || !PROJECT.test(p)) problems.push(`${key} names a project that is not a project id: "${p}"`);
    return `\`${p}\`.\`${d}\`.\`${t}\``;
  };
  const freshness = (route: TargetRoute): "oldest" | "newest" => {
    const value = text(`${route}.freshness`) ?? "oldest";
    if (value !== "oldest" && value !== "newest") problems.push(`${route}.freshness is "oldest" or "newest", not "${value}"`);
    return value === "newest" ? "newest" : "oldest";
  };

  const location = text("location");
  const network = text("network");
  let maximumBytesBilled: string | undefined;
  const cap = options.maximumBytesBilled;
  if (cap !== undefined) {
    if (typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0) maximumBytesBilled = String(cap);
    else if (typeof cap === "string" && /^[1-9][0-9]*$/.test(cap)) maximumBytesBilled = cap;
    else problems.push(`maximumBytesBilled must be a positive whole number of bytes, not "${String(cap)}"`);
  }

  const companyId = column("candidates.companyIdColumn", false);
  if (companyId && !network) problems.push("candidates.companyIdColumn needs network: the company ids are on a network the instance names");
  const candidates = {
    table: table("candidates.table"),
    extractedAt: column("candidates.extractedAtColumn", true) ?? "",
    freshness: freshness("candidates"),
    statusColumn: column("candidates.statusColumn", true) ?? "",
    domain: column("candidates.domainColumn", true) ?? "",
    ...(scalar("candidates.status") !== undefined ? { status: scalar("candidates.status") } : {}),
    ...(companyId ? { companyId } : {}),
    ...optional("candidates.idColumn", "id"),
    ...optional("candidates.nameColumn", "name"),
  };

  if (options["protected.activeValues"] === undefined) problems.push("protected.activeValues is required");
  const activeValues = (scalar("protected.activeValues") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (options["protected.activeValues"] !== undefined && activeValues.length === 0) problems.push("protected.activeValues lists no value");
  // The column is compared as text, and a BOOLEAN reads as "true" or "false",
  // lowercase. `TRUE` would match nothing, and with allowEmpty an unprotected
  // run would look like an empty protected set. Refused here, not discovered.
  for (const value of activeValues) {
    if (/^(true|false)$/i.test(value) && value !== value.toLowerCase()) {
      problems.push(`protected.activeValues has "${value}": a BOOLEAN column reads as "${value.toLowerCase()}", lowercase`);
    }
  }
  const reason = (text("protected.reason") ?? "customer") as ProtectionReason;
  if (!REASONS.includes(reason)) problems.push(`protected.reason is one of ${REASONS.join(", ")}, not "${reason}"`);
  const allowEmpty = options["protected.allowEmpty"];
  if (allowEmpty !== undefined && typeof allowEmpty !== "boolean") problems.push("protected.allowEmpty is true or false");
  const protectedRoute = {
    table: table("protected.table"),
    extractedAt: column("protected.extractedAtColumn", true) ?? "",
    freshness: freshness("protected"),
    activeColumn: column("protected.activeColumn", true) ?? "",
    activeValues,
    domain: column("protected.domainColumn", true) ?? "",
    reason,
    allowEmpty: allowEmpty === true,
    ...optional("protected.idColumn", "id"),
    ...optional("protected.nameColumn", "name"),
  };

  function optional<K extends string>(key: string, as: K): Partial<Record<K, string>> {
    const value = column(key, false);
    return (value ? { [as]: value } : {}) as Partial<Record<K, string>>;
  }

  if (problems.length > 0) return { problems };
  return {
    project,
    ...(location ? { location } : {}),
    ...(maximumBytesBilled ? { maximumBytesBilled } : {}),
    ...(network ? { network } : {}),
    candidates,
    protected: protectedRoute,
  };
}

/* -------------------------------------------------------------------------- */
/* The queries — every one of them, so that what each reads is in one place    */
/* -------------------------------------------------------------------------- */

const q = (column: string) => `\`${column}\``;
const asString = (column: string, alias: string) => `CAST(${q(column)} AS STRING) AS ${alias}`;

/**
 * The route's age: one column of one table, plus the row count, which is
 * metadata. The column may be a TIMESTAMP, a DATETIME (read as UTC), a DATE
 * (read as its midnight, UTC — older than the truth, never fresher) or an ISO
 * string; anything else fails the cast, and the query with it. The whole
 * table is read, not the route's rows: for the oldest, that can only make the
 * age older.
 */
export function freshnessSql(route: RouteConfig): string {
  const at = `CAST(${q(route.extractedAt)} AS TIMESTAMP)`;
  const pick = route.freshness === "oldest" ? `MIN(${at})` : `MAX(${at})`;
  return [
    `SELECT FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ', ${pick}, 'UTC') AS as_of,`,
    `CAST(COUNTIF(${q(route.extractedAt)} IS NULL) AS STRING) AS undated,`,
    `CAST(COUNT(*) AS STRING) AS row_count`,
    `FROM ${route.table}`,
  ].join(" ");
}

export function candidatesSql(c: Config["candidates"]): string {
  const columns = [
    asString(c.domain, "domain"),
    ...(c.companyId ? [asString(c.companyId, "company_id")] : []),
    ...(c.id ? [asString(c.id, "external_id")] : []),
    ...(c.name ? [asString(c.name, "name")] : []),
  ];
  // Ordered, so that the first page of a limited read is the same page twice.
  const order = ["domain", ...(c.companyId ? ["company_id"] : []), ...(c.id ? ["external_id"] : [])];
  return `SELECT ${columns.join(", ")} FROM ${c.table} WHERE CAST(${q(c.statusColumn)} AS STRING) = @status ORDER BY ${order.join(", ")}`;
}

export function protectedSql(p: Config["protected"]): string {
  const columns = [
    asString(p.domain, "domain"),
    asString(p.activeColumn, "active"),
    ...(p.id ? [asString(p.id, "external_id")] : []),
    ...(p.name ? [asString(p.name, "name")] : []),
  ];
  // The NULLs come back too, to be refused: they are the accounts whose
  // subscription nobody can state.
  return `SELECT ${columns.join(", ")} FROM ${p.table} WHERE CAST(${q(p.activeColumn)} AS STRING) IN UNNEST(@active) OR ${q(p.activeColumn)} IS NULL`;
}

/* -------------------------------------------------------------------------- */
/* The cursor: which job, which page, how many rows already read               */
/* -------------------------------------------------------------------------- */

interface Cursor {
  route: TargetRoute;
  job: string;
  location?: string;
  page: string;
  /** Rows already handed out, to tell a finished read from one cut short. */
  read: number;
}

const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decodeCursor(text: string, route: TargetRoute): Cursor | undefined {
  try {
    const c = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<Cursor>;
    if (c.route !== route || typeof c.job !== "string" || typeof c.page !== "string" || typeof c.read !== "number") return undefined;
    if (c.location !== undefined && typeof c.location !== "string") return undefined;
    return c as Cursor;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP to CallResult                                                          */
/* -------------------------------------------------------------------------- */

/** BigQuery's error reasons, from its published list. The status alone is not enough: 403 is both "denied" and "slow down". */
function errorFor(status: number, body: string): CallError {
  let parsed: { error?: { message?: string; errors?: { reason?: string }[] } } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    /* not JSON: the status says enough */
  }
  const reason = parsed.error?.errors?.[0]?.reason;
  const detail = (parsed.error?.message ?? body).slice(0, 300);
  const provider = reason ? { providerCode: reason } : {};
  if (reason === "rateLimitExceeded" || reason === "jobRateLimitExceeded" || status === 429) {
    return { code: "rate_limited", message: detail, retryable: true, retryAfterMs: 5_000, ...provider };
  }
  if (reason === "quotaExceeded") return { code: "rate_limited", message: detail, retryable: false, ...provider };
  if (status === 401) return { code: "unauthorized", message: "the credentials were refused", retryable: false, ...provider };
  if (status === 403) return { code: "unauthorized", message: detail, retryable: false, ...provider };
  if (status === 404) return { code: "not_found", message: detail, retryable: false, ...provider };
  if (status === 400) return { code: "invalid", message: detail, retryable: false, ...provider };
  if (status >= 500) return { code: "unavailable", message: `upstream ${status}: ${detail}`, retryable: true, retryAfterMs: 5_000, ...provider };
  return { code: "unknown", message: `unexpected ${status}: ${detail}`, retryable: false, providerCode: reason ?? String(status) };
}

function errorForThrown(thrown: unknown, timeoutMs: number): CallError {
  if (thrown instanceof Error && thrown.name === "TimeoutError") {
    return { code: "unavailable", message: `no answer within ${timeoutMs} ms`, retryable: true, retryAfterMs: 5_000 };
  }
  if (thrown instanceof Error && thrown.name === "AbortError") return { code: "unavailable", message: "cancelled", retryable: false };
  return { code: "unavailable", message: thrown instanceof Error ? thrown.message : String(thrown), retryable: true, retryAfterMs: 5_000 };
}

/* -------------------------------------------------------------------------- */

const factory: AdapterFactory<TargetList> = ({ options, env }) => {
  const config = configure(options);
  const baseUrl = String(options.baseUrl ?? "https://bigquery.googleapis.com/bigquery/v2").replace(/\/$/, "");
  // Two bounds, so that each failure says what it is: every request has this
  // deadline (a warehouse that does not answer), and so does the wait for a
  // job to complete (a warehouse that answers "not yet" for ever). Neither
  // becomes a run that never ends.
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 60_000;

  const keyText = env.BIGQUERY_SERVICE_ACCOUNT;
  const staticToken = env.BIGQUERY_ACCESS_TOKEN;
  let cached: { token: string; until: number } | undefined;

  /** The only network call in this file. */
  async function send(url: string, init: RequestInit, ctx: CallContext): Promise<CallResult<string>> {
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline });
      const text = await response.text();
      if (!response.ok) return { ok: false, error: errorFor(response.status, text) };
      return { ok: true, value: text };
    } catch (thrown) {
      return { ok: false, error: errorForThrown(thrown, timeoutMs) };
    }
  }

  /** A bearer token: the one given, or one exchanged for a signed assertion and kept until a minute before it expires. */
  async function token(ctx: CallContext): Promise<CallResult<string>> {
    if (keyText && staticToken) return fail("invalid", "set BIGQUERY_SERVICE_ACCOUNT or BIGQUERY_ACCESS_TOKEN, not both");
    if (staticToken) return { ok: true, value: staticToken };
    if (!keyText) return fail("unauthorized", "neither BIGQUERY_SERVICE_ACCOUNT nor BIGQUERY_ACCESS_TOKEN is set");
    if (cached && cached.until > Date.now()) return { ok: true, value: cached.token };

    let key: ServiceAccountKey;
    try {
      key = JSON.parse(keyText) as ServiceAccountKey;
    } catch {
      return fail("unauthorized", "BIGQUERY_SERVICE_ACCOUNT is not a JSON key");
    }
    if (typeof key.client_email !== "string" || typeof key.private_key !== "string") {
      return fail("unauthorized", "BIGQUERY_SERVICE_ACCOUNT has no client_email or private_key");
    }
    const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
    let signature: string;
    try {
      signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
    } catch {
      return fail("unauthorized", "BIGQUERY_SERVICE_ACCOUNT's private_key cannot sign");
    }
    const exchanged = await send(
      tokenUri,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
      },
      ctx,
    );
    if (!exchanged.ok) {
      // The token endpoint answers a refused key with 400; that is not an invalid query.
      return exchanged.error.code === "invalid" ? fail("unauthorized", `the key was refused: ${exchanged.error.message}`) : exchanged;
    }
    let granted: { access_token?: string; expires_in?: number };
    try {
      granted = JSON.parse(exchanged.value) as typeof granted;
    } catch {
      return fail("unauthorized", "the token endpoint did not answer in JSON");
    }
    if (!granted.access_token) return fail("unauthorized", "the token endpoint granted no token");
    cached = { token: granted.access_token, until: Date.now() + Math.max(0, (granted.expires_in ?? 0) - 60) * 1000 };
    return { ok: true, value: granted.access_token };
  }

  async function api(method: "GET" | "POST", path: string, ctx: CallContext, body?: unknown): Promise<CallResult<QueryResponse>> {
    const bearer = await token(ctx);
    if (!bearer.ok) return bearer;
    const sent = await send(
      `${baseUrl}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${bearer.value}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      ctx,
    );
    if (!sent.ok) return sent;
    try {
      return { ok: true, value: JSON.parse(sent.value) as QueryResponse };
    } catch {
      return fail("unknown", "BigQuery answered with something that is not JSON");
    }
  }

  type Param = { name: string; parameterType: unknown; parameterValue: unknown };
  const stringParam = (name: string, value: string): Param => ({ name, parameterType: { type: "STRING" }, parameterValue: { value } });
  const arrayParam = (name: string, values: string[]): Param => ({
    name,
    parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
    parameterValue: { arrayValues: values.map((value) => ({ value })) },
  });

  /** The rows of a complete page, by column name, or why there are none to trust. */
  function rowsOf(page: QueryResponse): CallResult<Row[]> {
    if (!page.schema?.fields) {
      const why = page.errors?.map((e) => e.message ?? e.reason).join("; ") || "no schema";
      return fail("unknown", `the job completed without a result: ${why}`);
    }
    const names = page.schema.fields.map((f) => f.name);
    const rows: Row[] = [];
    for (const row of page.rows ?? []) {
      if (!Array.isArray(row.f) || row.f.length !== names.length) return fail("unknown", "a row does not match the result's schema");
      rows.push(Object.fromEntries(names.map((n, i) => [n, row.f[i]?.v ?? null])));
    }
    return { ok: true, value: rows };
  }

  /**
   * Waits for a job to complete, within the read's deadline. `jobs.getQueryResults`
   * itself waits server-side up to `timeoutMs`, so this loop does not sleep.
   */
  async function complete(first: QueryResponse, maxResults: number, ctx: CallContext, started: number): Promise<CallResult<QueryResponse>> {
    let page = first;
    while (!page.jobComplete) {
      const job = page.jobReference?.jobId;
      if (!job) return fail("unknown", "the job is not complete and BigQuery named no job to wait on");
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) return fail("unavailable", `the job did not complete within ${timeoutMs} ms`, true, { retryAfterMs: 5_000 });
      const params = new URLSearchParams({ maxResults: String(maxResults), timeoutMs: String(Math.min(left, 10_000)) });
      if (page.jobReference?.location) params.set("location", page.jobReference.location);
      const next = await api("GET", `/projects/${encodeURIComponent(page.jobReference?.projectId ?? (config as Config).project)}/queries/${encodeURIComponent(job)}?${params}`, ctx);
      if (!next.ok) return next;
      page = { ...next.value, jobReference: next.value.jobReference ?? page.jobReference };
    }
    return { ok: true, value: page };
  }

  /** Runs a query, or continues one from a cursor; returns one page, and the cursor to the next. */
  async function read(
    route: TargetRoute,
    sql: string,
    parameters: Param[],
    query: TargetQuery,
    ctx: CallContext,
  ): Promise<CallResult<{ rows: Row[]; next?: string; read: number; total: number }>> {
    const c = config as Config;
    const maxResults = Math.min(Math.max(1, Math.floor(query.limit ?? PAGE)), MAX_PAGE);
    const started = Date.now();

    let page: CallResult<QueryResponse>;
    let already = 0;
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor, route);
      if (!cursor) return fail("invalid", `the cursor is not one this adapter handed out for the ${route} route`);
      already = cursor.read;
      const params = new URLSearchParams({ pageToken: cursor.page, maxResults: String(maxResults), timeoutMs: "10000" });
      if (cursor.location) params.set("location", cursor.location);
      page = await api("GET", `/projects/${encodeURIComponent(c.project)}/queries/${encodeURIComponent(cursor.job)}?${params}`, ctx);
      if (page.ok) page = { ok: true, value: { ...page.value, jobReference: page.value.jobReference ?? { jobId: cursor.job, ...(cursor.location ? { location: cursor.location } : {}) } } };
    } else {
      page = await api("POST", `/projects/${encodeURIComponent(c.project)}/queries`, ctx, {
        query: sql,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: parameters,
        maxResults,
        timeoutMs: Math.min(timeoutMs, 10_000),
        ...(c.location ? { location: c.location } : {}),
        ...(c.maximumBytesBilled ? { maximumBytesBilled: c.maximumBytesBilled } : {}),
      });
    }
    if (!page.ok) return page;
    const done = await complete(page.value, maxResults, ctx, started);
    if (!done.ok) return done;

    const rows = rowsOf(done.value);
    if (!rows.ok) return rows;
    const total = Number(done.value.totalRows ?? Number.NaN);
    if (!Number.isSafeInteger(total)) return fail("unknown", "BigQuery did not say how many rows the result holds");
    const read = already + rows.value.length;
    if (read > total) return fail("unknown", `the result announced ${total} rows and handed out ${read}`);

    if (done.value.pageToken) {
      if (rows.value.length === 0) return fail("unknown", "BigQuery returned an empty page that is not the last");
      const job = done.value.jobReference?.jobId;
      if (!job) return fail("unknown", "a page follows, and BigQuery named no job to read it from");
      const location = done.value.jobReference?.location;
      const next = encodeCursor({ route, job, ...(location ? { location } : {}), page: done.value.pageToken, read });
      return { ok: true, value: { rows: rows.value, next, read, total } };
    }
    // The last page: everything announced must have been handed out.
    if (read !== total) return fail("unknown", `the result ended after ${read} of the ${total} rows it announced`);
    return { ok: true, value: { rows: rows.value, read, total } };
  }

  const clean = (value: string | null | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  function company(row: Row, c: Config): TargetCompany {
    const domain = clean(row.domain);
    const companyId = clean(row.company_id);
    const externalId = clean(row.external_id);
    const name = clean(row.name);
    const keys: Identity["keys"] = [
      ...(domain ? [{ kind: "domain", value: domain }] : []),
      ...(companyId && c.network ? [{ kind: "social_company_id", value: companyId, network: c.network }] : []),
    ];
    return {
      ...(externalId ? { externalId } : {}),
      ...(name ? { name } : {}),
      ...(domain ? { domain } : {}),
      ...(keys.length > 0 ? { identity: { subject: "company", keys } } : {}),
      attributes: {},
    };
  }

  const misconfigured = () => fail("invalid", `the binding's options are not usable: ${(config as { problems: string[] }).problems.join("; ")}`);

  return {
    provider: "bigquery",

    /**
     * Both freshness queries as dry runs: they bill nothing, and they need what
     * every real read needs — credentials, the project, both tables and their
     * extraction columns. A dry run answers with statistics and no rows.
     */
    async probe(ctx): Promise<CallResult<void>> {
      if ("problems" in config) return misconfigured();
      for (const route of [config.candidates, config.protected]) {
        const checked = await api("POST", `/projects/${encodeURIComponent(config.project)}/queries`, ctx, {
          query: freshnessSql(route),
          useLegacySql: false,
          dryRun: true,
          ...(config.location ? { location: config.location } : {}),
        });
        if (!checked.ok) return checked;
      }
      return { ok: true, value: undefined };
    },

    async freshness(route, ctx): Promise<CallResult<TargetListFreshness>> {
      if ("problems" in config) return misconfigured();
      if (route !== "candidates" && route !== "protected") return fail("invalid", `no route "${String(route)}"`);
      const r = route === "candidates" ? config.candidates : config.protected;
      const got = await read(route, freshnessSql(r), [], {}, ctx);
      if (!got.ok) return got;
      const row = got.value.rows[0];
      if (got.value.rows.length !== 1 || !row) return fail("unknown", "the age query did not return one row");
      if (row.row_count === "0") return fail("unavailable", `the ${route} table is empty, so it says nothing of when it was extracted`);
      if (r.freshness === "oldest" && row.undated !== "0") {
        return fail("unavailable", `${row.undated} rows of the ${route} table have no extraction time, so its age is unknown`);
      }
      const asOf = row.as_of;
      if (!asOf || Number.isNaN(Date.parse(asOf))) return fail("unavailable", `the ${route} table gives no extraction time that is a time`);
      return { ok: true, value: { route, asOf } };
    },

    async candidates(query, ctx): Promise<CallResult<TargetPage<TargetCompany>>> {
      if ("problems" in config) return misconfigured();
      // `status` is the one selector this source takes. Any other would be
      // ignored, and a caller would believe it had filtered.
      const unknown = Object.keys(query.params ?? {}).filter((k) => k !== "status");
      if (unknown.length > 0) return fail("invalid", `this target list takes only a "status" param, not ${unknown.join(", ")}`);
      const asked = query.params?.status;
      const status = asked !== undefined ? String(asked) : config.candidates.status;
      if (status === undefined) return fail("invalid", "no status to filter on: set candidates.status, or pass a status param");
      const got = await read("candidates", candidatesSql(config.candidates), [stringParam("status", status)], query, ctx);
      if (!got.ok) return got;
      return {
        ok: true,
        value: { items: got.value.rows.map((row) => company(row, config)), ...(got.value.next ? { nextCursor: got.value.next } : {}) },
      };
    },

    async protectedAccounts(query, ctx): Promise<CallResult<TargetPage<ProtectedAccount>>> {
      if ("problems" in config) return misconfigured();
      if (query.params && Object.keys(query.params).length > 0) return fail("invalid", "the protected set takes no params: it is read whole");
      const p = config.protected;
      const got = await read("protected", protectedSql(p), [arrayParam("active", p.activeValues)], query, ctx);
      if (!got.ok) return got;
      const unknown = got.value.rows.filter((row) => row.active === null).length;
      if (unknown > 0) {
        return fail(
          "unavailable",
          `${unknown} account${unknown === 1 ? "'s" : "s'"} ${p.activeColumn} is NULL: an unknown subscription is not an absent one, and the protected set is not read past it`,
        );
      }
      if (got.value.total === 0 && !p.allowEmpty) {
        return fail(
          "unavailable",
          "no account is protected: an active value that matches nothing looks exactly like this. If the set is truly empty, say protected.allowEmpty: true",
        );
      }
      const items = got.value.rows.map((row): ProtectedAccount => {
        const domain = clean(row.domain);
        const externalId = clean(row.external_id);
        const name = clean(row.name);
        return { ...(externalId ? { externalId } : {}), ...(name ? { name } : {}), ...(domain ? { domain } : {}), reason: p.reason };
      });
      return { ok: true, value: { items, ...(got.value.next ? { nextCursor: got.value.next } : {}) } };
    },
  };
};

export default factory;
