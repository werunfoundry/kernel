/**
 * core/manifest — what a domain declares, and what an instance fills in.
 *
 * The engine owns these shapes; an instance owns their values. That split is
 * the reason a second company is a folder of configuration rather than a
 * second repository (doctrine 8).
 *
 * Nothing here names a business concept: `TruthDoc` does not know what an ICP
 * is, and `DomainManifest` does not know what a channel means. Domains supply
 * both (doctrine 1).
 */

/** An inclusive range. Either bound may be omitted. */
export interface Range {
  min?: number;
  max?: number;
}

/* -------------------------------------------------------------------------- */
/* What a domain declares — domain.yaml                                        */
/* -------------------------------------------------------------------------- */

export interface DomainManifest {
  /** Matches the folder name and the Postgres schema it owns. */
  name: string;
  version: string;
  description: string;

  /** The Postgres schema this domain owns, and drops with it. */
  schema: string;

  /**
   * The names this domain was known by before (decision 0046). Migrations
   * applied under a former name are recognised under this one, not replayed.
   * It renames nothing else: the domain's own migration renames its schema,
   * and data keeps the names it was written with.
   */
  formerly?: string[];

  /**
   * Domains this one may reference. A foreign key is legal only into `core`
   * or into a name listed here (doctrine 2), and that is checked.
   */
  dependsOn: string[];

  /**
   * Vocabulary this domain contributes. These are not enums in the database,
   * because a Postgres enum cannot be extended by a domain that does not own
   * the type. The union of enabled domains' declarations is what validation
   * accepts.
   */
  channels?: string[];
  experimentTypes?: string[];
  eventTypes?: string[];

  /** Kinds of truth this domain understands, e.g. `icp`, `persona`. */
  truthKinds?: string[];

  /**
   * The settings an instance may put on a binding of a contract this domain
   * reads, beside the adapter's options (decision 0069). The core loads
   * them, refuses a key no enabled domain declares for that contract, and
   * reads none of them: the declaring domain does, and the adapter is never
   * handed them. What a value means, and whether it is well formed, is the
   * domain's.
   */
  bindingSettings?: BindingSettingDeclaration[];

  /**
   * The keys that name the subjects this domain owns (decision 0013). A kind
   * is declared by one domain only: two needing it is the signal it moves
   * down.
   */
  identityKeys?: IdentityKeyKind[];

  /**
   * The numbers this domain defines, namespaced like its events —
   * `acquisition.replied` (decision 0018). A metric source says which it can read;
   * nothing here stores them.
   */
  metrics?: MetricDeclaration[];

  /**
   * What erasing a subject does to each table of this domain that names it
   * (decision 0040): delete the rows, empty listed columns, or keep them under
   * a stated legal basis. The core orchestrates; the domain answers. A rule on
   * the subject's own row may list `ifStillNamed`: the columns emptied when a
   * kept row elsewhere still points at it, so it cannot be deleted. Where a
   * domain keeps the history of what it did, it anonymises: the row says what
   * happened, not who (decision 0049).
   */
  erasure?: ErasureRule[];

  /**
   * A step erasure runs before any rule, outside its transaction (decision
   * 0056): what this domain must do elsewhere — at a provider — before the
   * kernel forgets the subject. Named as an export of this domain's own
   * package, `@werunfoundry/<name>/<path>`, and loaded the way an adapter is,
   * by resolution: the core never imports a domain. Its export
   * `beforeErasure` is a `BeforeErasure` (`core/runtime/erase.ts`).
   */
  beforeErasure?: string;

  /**
   * A step erasure runs inside its transaction, once the subject's keys are
   * gathered and before any rule (decision 0062): what this domain writes
   * that must commit or roll back with the deletion. Named and loaded as
   * `beforeErasure` is; its export `duringErasure` is a `DuringErasure`
   * (`core/runtime/erase.ts`). It is handed no secret and no adapter.
   */
  duringErasure?: string;

  /**
   * For each experiment type, the metrics it is judged on. What gives an
   * experiment type a surface: an instance can tell, before running one,
   * whether its bound sources can measure it.
   */
  experimentMetrics?: Record<string, string[]>;
}

export interface BindingSettingDeclaration {
  /** The contract whose bindings may carry it. */
  contract: string;
  /** The key under the binding's `settings`. */
  key: string;
}

export interface MetricDeclaration {
  key: string;
  /** What is counted, e.g. `people`, `replies`. */
  unit: string;
  /**
   * The channels on which this metric means something; absent means every
   * channel. Elsewhere it is not applicable — never zero. A bounce on a
   * channel that cannot bounce is not a measurement, and a guardrail that
   * reads zero by construction guards nothing (the rule 0009 set for probes:
   * absent is reported as absent, never as health).
   */
  channels?: string[];
}

/** One kind of identity key, as a domain declares it. */
export interface IdentityKeyKind {
  kind: string;
  /** What it names, e.g. `person`. Declared here, never in the core. */
  subject: string;
  /**
   * Whether a value, once issued, always names the same subject. Immutable
   * keys are authoritative: two identities whose immutable keys of one kind
   * differ are different subjects, whatever else they share.
   */
  immutable: boolean;
  /** Whether a value only means something within a network the instance declares. */
  networked?: boolean;
  /** Whether case carries no meaning, as in an address or a domain. */
  caseInsensitive?: boolean;
  /**
   * Whether the value names a host on the web, so that what a source wraps
   * around one — a scheme, `www.`, a port, a path, a trailing dot — is not
   * part of it (decision 0028). Compared as `hostOf` leaves it.
   */
  hostname?: boolean;
}

/* -------------------------------------------------------------------------- */
/* What an instance declares                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How a capability is satisfied. The instance names the adapter and the
 * environment variables that carry its credentials — never the credentials
 * themselves (doctrine 7).
 */
export interface ProviderBinding {
  /** The contract being satisfied, e.g. `crm`, `sequencer`, `targetList`. */
  contract: string;
  /** The adapter package implementing it. */
  adapter: string;
  /** Names of environment variables. Values live in the environment. */
  env: string[];
  options?: Record<string, string | number | boolean>;
  /**
   * Values a domain declared for this contract's bindings (decision 0069),
   * by key. Not the adapter's: it is never handed them. The core checks the
   * keys and nothing else.
   */
  settings?: Record<string, unknown>;
  /**
   * The channels this binding takes (decision 0015). Defaults to every
   * channel the adapter declares. A contract may be bound more than once,
   * one adapter per channel, and never two on the same channel.
   */
  channels?: string[];
  /**
   * The identity key kinds this binding is asked for (decision 0030).
   * Defaults to every kind the adapter declares. A contract bound more than
   * once without channels is bound in sequence, in the order of `providers`.
   */
  finds?: string[];
}

export interface InstanceManifest {
  /**
   * Opaque identifier for this deployment. Used in logs and run records. It
   * is not a tenant key: one deployment is one tenant (doctrine 2).
   */
  instance: string;

  enabledDomains: string[];
  providers: ProviderBinding[];

  /** Directory holding truth documents, relative to the instance root. */
  truthsDir: string;

  /**
   * The networks a networked identity key may belong to (decision 0013).
   * Here and not in a domain, because naming one names a provider, which the
   * kernel never does (doctrine 6) and the instance may. A key whose network
   * is not listed is refused.
   */
  networks?: string[];

  /**
   * The versions of the secret fingerprints are keyed under, and which one
   * writes (decisions 0058, 0063). A version's secret is never here: it is
   * in the variable `KERNEL_FINGERPRINT_<LABEL>`. Boot refuses a manifest
   * without this section.
   */
  fingerprints?: FingerprintVersions;
}

export interface FingerprintVersions {
  /** The label new entries are written under. It must be declared below. */
  writes: string;
  /**
   * Every version ever used. A label is never renamed, reused, or removed
   * while an entry names it (0058).
   */
  versions: FingerprintVersion[];
}

export interface FingerprintVersion {
  /** Upper-case letters and digits. */
  label: string;
  /** HMAC-SHA-256 of a fixed sentence under the secret, as `kernel-fingerprint` printed it. */
  check: string;
  /** Why it was added: a compromise, or whatever reason a person records (0058, §2). */
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Truths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A truth is a statement the instance holds to be true, with someone
 * accountable for it and a date it was last confirmed.
 *
 * It has two halves and they are kept apart on purpose. `spec` is the machine
 * half: filterable, validatable, and the thing a sourcing pass runs on. The
 * prose half stays prose, in files, because what makes copy good does not
 * survive being forced into a schema — and a schema nobody can fill is worse
 * than no schema.
 */
export interface TruthDoc<Spec = unknown> {
  /** Stable key referenced by rules and cited by generated work. */
  key: string;

  /** Declared by a domain in `truthKinds`. */
  kind: string;

  /** A handle resolved against instance configuration, not a user row. */
  owner: string;

  /** When a human last confirmed this. Staleness is a review signal. */
  validatedAt: string;

  /** The machine half. Shape comes from the domain that declares the kind. */
  spec?: Spec;

  /**
   * The prose half: paths to markdown files, relative to `truthsDir`. One
   * claim per file. Never inlined here, so that editing prose is editing
   * prose and not editing configuration.
   */
  notes?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type Severity = "error" | "warning";

export interface ValidationIssue {
  severity: Severity;
  /** Path into the document, e.g. `spec.firmographics.headcount`. */
  at: string;
  message: string;
  /** The doctrine rule this enforces, when it enforces one. */
  rule?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * One answer to erasure (decisions 0040, 0049). A rule reaches the subject's
 * rows by its id in `column`, by its keys in the identity `keys` holds, or
 * both — a row that names a person only by keys is theirs as much as one that
 * names them by id.
 *
 * - `keyColumns`, on the subject's own row: which of its columns hold which
 *   kind of key, so the core can gather them before anything changes. A
 *   networked kind is held as `<network>:<value>`.
 * - `anonymise` empties `columns`, removes the `strip` paths from each
 *   element of a JSON array, writes into `random` a value derived from
 *   nothing, and into `text` a fixed sentence — only where the column holds
 *   a value (0053); into a jsonb column, a JSON document.
 */
export type ErasureRule =
  | { table: string; column: string; do: "delete"; ifStillNamed?: string[]; keyColumns?: Record<string, string> }
  | {
      table: string;
      column?: string;
      keys?: string;
      do: "anonymise";
      columns?: string[];
      strip?: Record<string, string[]>;
      random?: string[];
      text?: Record<string, string>;
    }
  | { table: string; column?: string; keys?: string; do: "keep"; basis: string };
