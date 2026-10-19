/**
 * acquisition/manifest — the shapes an acquisition instance fills in.
 *
 * These are the two truth kinds this domain declares: which companies are
 * worth approaching, and which people inside them. Everything here is the
 * machine half — what a sourcing pass, an exclusion pass or a classifier can
 * execute. The reasons, the objections and the proof stay in prose files,
 * referenced from `TruthDoc.notes`.
 *
 * The split is the whole point. A prose description of a target market is
 * readable by a model and executable by nothing; a schema that swallows the
 * prose loses what makes the writing good. So: the filterable facts get a
 * shape, the rest stays written.
 */

import type { Range } from "@werunfoundry/core/manifest/types";

/**
 * Firmographic criteria. Every field is optional: an instance states what it
 * knows and leaves the rest out. An absent field is not a filter, never a
 * filter that matches everything by accident.
 */
export interface Firmographics {
  headcount?: Range;
  revenueEur?: Range;
  foundedYear?: Range;

  /**
   * Instance vocabulary, not a closed list: every market cuts its categories
   * differently, and a shared enum here would be wrong for the second
   * instance on the first day.
   */
  categories?: string[];
  excludeCategories?: string[];

  /** ISO 3166 country codes, or instance-defined region keys. */
  geographies?: string[];
  excludeGeographies?: string[];
}

/**
 * A signal that raises or lowers interest in an account, with how long it
 * stays meaningful. An expired signal is not a weak signal — it is gone, and
 * `maxAgeDays` is what says when.
 */
export interface SignalCriterion {
  /** Matches `relations.signal.kind`. */
  kind: string;
  weight?: number;
  maxAgeDays?: number;
}

/**
 * A named band inside a segment, and the condition that puts an account in
 * it. Tiers decide attention and, through the lane, how much review the work
 * requires.
 *
 * The condition is deliberately poor: firmographics plus required signals,
 * and nothing else. A richer predicate language is a thing to add when a real
 * rule cannot be expressed — not before, because an expression language is
 * easy to add and impossible to remove.
 */
export interface TierRule {
  key: string;
  label: string;
  /** Lower sorts first. Tier 1 is the most attention, not the most rows. */
  rank: number;
  when?: {
    firmographics?: Firmographics;
    requireSignals?: SignalCriterion[];
  };
}

/**
 * Which companies are worth approaching.
 *
 * An instance may declare several, one per motion, ordered by `priority`. The
 * first that matches wins, so order is a decision and not a detail.
 */
export interface IcpSpec {
  key: string;
  label: string;
  /** 1 is the primary motion. */
  priority: number;

  firmographics?: Firmographics;
  signals?: SignalCriterion[];
  tiers?: TierRule[];

  /**
   * Audience keys that always win over this definition. An account in one of
   * these is out, whatever else matches — the exclusion pass fails closed
   * (doctrine 6).
   */
  excludeAudiences?: string[];
}

/**
 * Which people inside those companies, and what the classifier is deciding
 * between.
 *
 * `roles` is the vocabulary a classifier may return. It is declared here
 * rather than hardcoded so the classifier's prompt can be generated from this
 * document instead of maintained beside it and drifting from it.
 */
export interface PersonaSpec {
  key: string;
  label: string;

  /** Which ICP this persona belongs to. */
  icp: string;

  /** Title fragments, matched case-insensitively. */
  titleIncludes?: string[];
  titleExcludes?: string[];

  seniority?: string[];
  functions?: string[];

  /**
   * The closed set the classifier chooses from, e.g. decision maker,
   * champion, influencer, ignore. Instance vocabulary.
   */
  roles: string[];

  /** How many people to approach at one account, per motion. */
  contactsPerAccount?: Range;
}

export type AcquisitionTruthSpec = IcpSpec | PersonaSpec;
