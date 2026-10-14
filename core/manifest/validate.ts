/**
 * core/manifest — the validator.
 *
 * The shapes in `types.ts` are the published contract: anyone reading this
 * repository can see what a manifest is without knowing a validation library.
 * The schemas here are the runtime half of the same contract, and the two are
 * tied together at the bottom of this file by assignability checks that fail
 * the typecheck if they ever drift.
 *
 * What this file does *not* do is as deliberate as what it does. It knows
 * nothing about an ICP, a persona or a channel's meaning (doctrine 1): it
 * checks names, shapes, references and the rules that hold for every domain.
 * A domain validates its own truth specs.
 */

import { z } from "zod";

import type {
  DomainManifest,
  IdentityKeyKind,
  InstanceManifest,
  ProviderBinding,
  Severity,
  TruthDoc,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A name that is safe as a Postgres identifier unquoted, and readable as a
 * folder. The restriction is not cosmetic: a schema name that needs quoting
 * will eventually be used somewhere that forgets to quote it.
 */
const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores, starting with a letter")
  .max(48);

/** `domain.thing` or `domain.thing.happened`. The prefix is the namespace. */
const namespacedKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]+)+$/, "expected `domain.name`");

/** A *name*, never a value (doctrine 7). */
const envVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "an environment variable name, not its value");

/** A path inside the instance. Never absolute, never upward. */
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), "must be relative to the instance root")
  .refine((p) => !p.split("/").includes(".."), "must not climb out of the instance");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, "expected an ISO date");

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const domainManifestSchema = z.object({
  name: identifier,
  version: z.string().min(1),
  description: z.string().min(1),
  schema: identifier,
  dependsOn: z.array(identifier).default([]),
  channels: z.array(identifier).optional(),
  experimentTypes: z.array(identifier).optional(),
  eventTypes: z.array(namespacedKey).optional(),
  truthKinds: z.array(identifier).optional(),
  metrics: z.array(z.object({ key: namespacedKey, unit: z.string().min(1) })).optional(),
  experimentMetrics: z.record(identifier, z.array(namespacedKey)).optional(),
  identityKeys: z
    .array(
      z.object({
        kind: identifier,
        subject: identifier,
        immutable: z.boolean(),
        networked: z.boolean().optional(),
        caseInsensitive: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const providerBindingSchema = z.object({
  contract: identifier,
  adapter: z.string().min(1),
  env: z.array(envVarName),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  channels: z.array(identifier).optional(),
});

export const instanceManifestSchema = z.object({
  instance: identifier,
  enabledDomains: z.array(identifier).min(1),
  providers: z.array(providerBindingSchema),
  truthsDir: relativePath,
  networks: z.array(identifier).optional(),
});

export const truthDocSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_-]*$/, "lowercase, digits, dash and underscore"),
  kind: identifier,
  owner: z.string().min(1),
  validatedAt: isoDate,
  spec: z.unknown().optional(),
  notes: z.record(z.string(), relativePath).optional(),
});

/* -------------------------------------------------------------------------- */
/* Running them                                                                */
/* -------------------------------------------------------------------------- */

const issue = (severity: Severity, at: string, message: string, rule?: number): ValidationIssue =>
  rule === undefined ? { severity, at, message } : { severity, at, message, rule };

function fromZod(error: z.ZodError, prefix: string): ValidationIssue[] {
  return error.issues.map((i) => {
    const path = i.path.map(String).join(".");
    return issue("error", path ? `${prefix}${path}` : prefix.replace(/\.$/, "") || "(root)", i.message);
  });
}

const result = (issues: ValidationIssue[]): ValidationResult => ({
  ok: !issues.some((i) => i.severity === "error"),
  issues,
});

/**
 * Validate one domain manifest on its own. Cross-domain checks — does a
 * declared dependency exist, is it enabled — need the whole set and live in
 * `validateInstance`.
 */
export function validateDomain(input: unknown): ValidationResult & { manifest?: DomainManifest } {
  const parsed = domainManifestSchema.safeParse(input);
  if (!parsed.success) return result(fromZod(parsed.error, ""));

  const m = parsed.data;
  const issues: ValidationIssue[] = [];

  if (m.schema !== m.name) {
    issues.push(issue("error", "schema", `a domain owns the schema of its own name: expected "${m.name}"`, 2));
  }
  if (m.dependsOn.includes(m.name)) {
    issues.push(issue("error", "dependsOn", "a domain cannot depend on itself", 2));
  }
  if (m.dependsOn.includes("core")) {
    issues.push(issue("warning", "dependsOn", "core is the bottom layer; depending on it is implicit", 2));
  }
  const kinds = new Set<string>();
  for (const [i, k] of (m.identityKeys ?? []).entries()) {
    if (kinds.has(k.kind)) issues.push(issue("error", `identityKeys.${i}.kind`, `"${k.kind}" is declared twice`));
    kinds.add(k.kind);
  }
  for (const [i, metric] of (m.metrics ?? []).entries()) {
    if (!metric.key.startsWith(`${m.name}.`)) {
      issues.push(issue("error", `metrics.${i}.key`, `a metric is namespaced by its domain: expected "${m.name}.…"`, 1));
    }
  }
  for (const type of Object.keys(m.experimentMetrics ?? {})) {
    if (!(m.experimentTypes ?? []).includes(type)) {
      issues.push(issue("error", `experimentMetrics.${type}`, `"${type}" is not an experiment type this domain declares`));
    }
  }
  for (const [i, key] of (m.eventTypes ?? []).entries()) {
    if (!key.startsWith(`${m.name}.`)) {
      issues.push(issue("error", `eventTypes.${i}`, `an event type is namespaced by its domain: expected "${m.name}.…"`, 1));
    }
  }

  const out = result(issues);
  return out.ok ? { ...out, manifest: m } : out;
}

/**
 * Validate an instance against the domains it claims to enable.
 *
 * The check that matters here is the transitive one: enabling a domain without
 * enabling what it depends on produces a database whose foreign keys point at
 * schemas that were never installed. It fails at migration time, loudly, which
 * is late — so it fails here instead.
 */
export function validateInstance(
  input: unknown,
  domains: readonly DomainManifest[],
): ValidationResult & { manifest?: InstanceManifest } {
  const parsed = instanceManifestSchema.safeParse(input);
  if (!parsed.success) return result(fromZod(parsed.error, ""));

  const m = parsed.data;
  const issues: ValidationIssue[] = [];
  const known = new Map(domains.map((d) => [d.name, d]));
  const enabled = new Set(m.enabledDomains);

  for (const [i, name] of m.enabledDomains.entries()) {
    const domain = known.get(name);
    if (!domain) {
      issues.push(issue("error", `enabledDomains.${i}`, `no domain named "${name}"`, 2));
      continue;
    }
    for (const dep of domain.dependsOn) {
      if (!enabled.has(dep)) {
        issues.push(issue("error", `enabledDomains.${i}`, `"${name}" depends on "${dep}", which is not enabled`, 2));
      }
    }
  }

  const owners = new Map<string, string>();
  for (const name of m.enabledDomains) {
    for (const k of known.get(name)?.identityKeys ?? []) {
      const owner = owners.get(k.kind);
      if (owner && owner !== name) {
        issues.push(
          issue(
            "error",
            "enabledDomains",
            `the identity key "${k.kind}" is declared by both "${owner}" and "${name}"; a key two domains need belongs one layer down`,
            2,
          ),
        );
      }
      owners.set(k.kind, name);
    }
  }
  // An experiment type may be judged on another enabled domain's metric, but
  // only on one some enabled domain declares.
  const metricKeys = new Set(m.enabledDomains.flatMap((n) => (known.get(n)?.metrics ?? []).map((x) => x.key)));
  for (const name of m.enabledDomains) {
    for (const [type, keys] of Object.entries(known.get(name)?.experimentMetrics ?? {})) {
      for (const key of keys) {
        if (!metricKeys.has(key)) {
          issues.push(issue("error", "enabledDomains", `"${name}" judges "${type}" on "${key}", which no enabled domain declares`));
        }
      }
    }
  }

  const networks = new Set<string>();
  for (const [i, n] of (m.networks ?? []).entries()) {
    if (networks.has(n)) issues.push(issue("error", `networks.${i}`, `"${n}" is listed twice`));
    networks.add(n);
  }

  // Channels a binding names explicitly are checked here; the ones an adapter
  // declares for itself are only known once it is built, and boot checks
  // those (decision 0015).
  const declaredChannels = new Set(m.enabledDomains.flatMap((n) => known.get(n)?.channels ?? []));
  const claimed = new Map<string, number>(); // `${contract}/${channel}` -> binding index
  for (const [i, binding] of m.providers.entries()) {
    const mine = new Set<string>();
    for (const [j, channel] of (binding.channels ?? []).entries()) {
      const at = `providers.${i}.channels.${j}`;
      if (!declaredChannels.has(channel)) issues.push(issue("error", at, `no enabled domain declares the channel "${channel}"`, 1));
      if (mine.has(channel)) issues.push(issue("error", at, `"${channel}" is listed twice`));
      mine.add(channel);
      const other = claimed.get(`${binding.contract}/${channel}`);
      if (other !== undefined) {
        issues.push(
          issue("error", at, `the channel "${channel}" of contract "${binding.contract}" is already taken by providers.${other}; one adapter per channel`),
        );
      } else {
        claimed.set(`${binding.contract}/${channel}`, i);
      }
    }
    if (binding.env.length === 0) {
      issues.push(issue("warning", `providers.${i}.env`, "no credentials declared; is this adapter really unauthenticated?"));
    }
  }

  const out = result(issues);
  return out.ok ? { ...out, manifest: m } : out;
}

/**
 * Validate a truth document's envelope. The `spec` is passed through
 * untouched: its shape belongs to the domain that declared the kind, and the
 * core does not know what an ICP is.
 */
export function validateTruth(
  input: unknown,
  options: { knownKinds?: readonly string[]; staleAfterDays?: number; now?: Date } = {},
): ValidationResult & { truth?: TruthDoc } {
  const parsed = truthDocSchema.safeParse(input);
  if (!parsed.success) return result(fromZod(parsed.error, ""));

  const t = parsed.data;
  const issues: ValidationIssue[] = [];

  if (options.knownKinds && !options.knownKinds.includes(t.kind)) {
    issues.push(issue("error", "kind", `no enabled domain declares the truth kind "${t.kind}"`, 1));
  }

  const now = options.now ?? new Date();
  const validatedAt = new Date(t.validatedAt);
  if (Number.isNaN(validatedAt.getTime())) {
    issues.push(issue("error", "validatedAt", "not a date"));
  } else {
    if (validatedAt.getTime() > now.getTime()) {
      issues.push(issue("error", "validatedAt", "confirmed in the future"));
    }
    const staleAfterDays = options.staleAfterDays ?? 90;
    const ageDays = (now.getTime() - validatedAt.getTime()) / 86_400_000;
    if (ageDays > staleAfterDays) {
      issues.push(
        issue("warning", "validatedAt", `last confirmed ${Math.round(ageDays)} days ago; nobody has stood behind this since`),
      );
    }
  }

  for (const [name, path] of Object.entries(t.notes ?? {})) {
    if (!path.endsWith(".md")) {
      issues.push(issue("warning", `notes.${name}`, "the prose half is markdown; this does not look like it"));
    }
  }

  const out = result(issues);
  return out.ok ? { ...out, truth: t as TruthDoc } : out;
}

/* -------------------------------------------------------------------------- */
/* The contract and the schemas are the same thing                             */
/* -------------------------------------------------------------------------- */

/**
 * If a schema above and its interface in `types.ts` ever disagree, one of these
 * stops compiling. That is the whole mechanism: there is no generated file to
 * regenerate and no comment asking anyone to remember.
 *
 * These are types, not values. An earlier version of this block used `declare
 * const` and assignments, which type-stripping runtimes happily shipped —
 * leaving a module that threw on import. A check that cannot run at runtime
 * must not exist at runtime.
 */
type Expect<T extends true> = T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type _DomainManifestMatches = Expect<
  Mutual<z.infer<typeof domainManifestSchema>, DomainManifest>
>;
export type _InstanceManifestMatches = Expect<
  Mutual<z.infer<typeof instanceManifestSchema>, InstanceManifest>
>;
export type _IdentityKeyKindMatches = Expect<
  Mutual<z.infer<typeof domainManifestSchema>["identityKeys"], IdentityKeyKind[] | undefined>
>;
export type _ProviderBindingMatches = Expect<
  Mutual<z.infer<typeof providerBindingSchema>, ProviderBinding>
>;

export type { ValidationIssue, ValidationResult };
