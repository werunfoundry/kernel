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
   * The keys that name the subjects this domain owns (decision 0013). A kind
   * is declared by one domain only: two needing it is the signal it moves
   * down.
   */
  identityKeys?: IdentityKeyKind[];
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
   * The channels this binding takes (decision 0015). Defaults to every
   * channel the adapter declares. A contract may be bound more than once,
   * one adapter per channel, and never two on the same channel.
   */
  channels?: string[];
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
