/**
 * Provider model discovery — canonical types.
 *
 * Live provider model lists are fetched at runtime, canonicalized into
 * `CanonicalModel`, and curated by deterministic rules (see ./curation.ts).
 * No file in src/ contains hardcoded model id arrays — the "shortlist" is
 * always derived from a fresh API response (with Redis cache as fallback).
 */

export type DiscoveryTier =
  | 'flagship'   // top reasoning/quality model in the family
  | 'balanced'   // mid-tier default
  | 'cheap'      // small/fast/cheap variant
  | 'reasoning'  // explicit reasoning model (o-series, thinking modes)
  | 'embedding'  // embedding-only models
  | 'other';     // anything not matching tier heuristics

export interface CanonicalModel {
  id: string;
  label: string;
  provider: string;
  tier: DiscoveryTier;
  /** Vendor-reported creation timestamp (ms epoch), if known. */
  createdAt?: number;
  /** Context window in tokens, if vendor exposes it. */
  contextWindow?: number;
  /** Max output tokens, if vendor exposes it. */
  maxOutputTokens?: number;
  /** Cost per 1M input tokens, if vendor exposes it. */
  costPerInputToken?: number;
  /** Cost per 1M output tokens, if vendor exposes it. */
  costPerOutputToken?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  /** Vendor flags this as preview/experimental. */
  isPreview?: boolean;
  /** Vendor flags this as deprecated. */
  isDeprecated?: boolean;
  /** Raw vendor payload for debugging — opaque. */
  raw?: unknown;
}

export interface CuratedSet {
  /** The shortlisted models, sorted flagship → balanced → cheap → reasoning. */
  shortlist: CanonicalModel[];
  /** Number of models hidden by curation rules (preview/deprecated/old/non-tool). */
  hiddenCount: number;
  /** When the underlying live data was fetched (ms epoch). */
  lastFetched: number;
  /** Whether the shortlist came from a fresh API call or cache. */
  source: 'live' | 'cache' | 'unconfigured';
  /** Provider-level error if discovery failed. */
  error?: string;
}

export interface ProviderDiscovery {
  provider: string;
  /** Hit the vendor's list endpoint with the supplied creds. */
  listAll(creds: DiscoveryCreds): Promise<CanonicalModel[]>;
}

export interface DiscoveryCreds {
  apiKey?: string;
  endpoint?: string;
}
