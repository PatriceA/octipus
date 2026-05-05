import type { CanonicalModel, CuratedSet, DiscoveryTier } from './types';

/**
 * Deterministic curation rules. Run on every fresh fetch — there is no
 * static shortlist file. New models released by the vendor automatically
 * surface as soon as the next discovery cycle picks them up.
 */

/** Models older than this fall out of "recent". */
const RECENCY_WINDOW_MS = 18 * 30 * 24 * 60 * 60 * 1000; // ~18 months

/** Family/category id patterns we always exclude (non-chat). */
const NON_CHAT_PATTERNS = [
  /embedding/i,
  /whisper/i,
  /\btts\b/i,
  /dall-?e/i,
  /moderation/i,
  /imagen/i,
  /\bveo\b/i,
  /\baqa\b/i,
  /\bocr\b/i,
  /transcribe/i,
  /audio/i,
  /realtime/i,
];

const PREVIEW_PATTERNS = [/preview/i, /-exp(-|$)/i, /experimental/i, /alpha/i, /beta/i, /\d{4}-\d{2}-\d{2}/];

const DEPRECATED_PATTERNS = [/deprecated/i, /legacy/i];

/** Heuristic tier inference from model id and label. */
export function inferTier(id: string, label?: string): DiscoveryTier {
  const s = `${id} ${label ?? ''}`.toLowerCase().trim();
  if (/embedding/.test(s)) return 'embedding';
  // "non-reasoning" is explicitly a cheap/fast variant (Grok); skip the reasoning bucket.
  if (/non-reasoning/.test(s)) return 'cheap';
  if (/\bo\d+(-mini|-pro)?\b|\breason|\bthinking\b/.test(s)) return 'reasoning';
  // Cheap *first* — "lite/mini/nano/haiku" beats flagship matchers like "opus" (none collide here).
  // Use \b boundaries so "geMINI" doesn't match "mini" and "claUDE" doesn't match "lite".
  if (/(-mini|-haiku|-lite|-nano|-small|-tiny|-fast|-flash-lite|\b8b\b|haiku\b)/.test(s)) return 'cheap';
  if (/(\bopus|frontier|ultra|\bpro\b|\bgpt-5\b|gpt-5\.|gpt-5-|gpt-4\.5|claude-opus|gemini-\d+(\.\d+)?-pro|\bgrok-\d)/.test(s)) return 'flagship';
  // Plain "flash" lands here (not flash-lite which is cheap, caught above).
  if (/(sonnet|gpt-4o|gemini-\d+(\.\d+)?-flash|\bmedium\b)/.test(s)) return 'balanced';
  return 'other';
}

export function isNonChat(id: string): boolean {
  return NON_CHAT_PATTERNS.some(p => p.test(id));
}

export function looksPreview(id: string, label?: string): boolean {
  const s = `${id} ${label ?? ''}`.toLowerCase();
  return PREVIEW_PATTERNS.some(p => p.test(s));
}

export function looksDeprecated(id: string, label?: string): boolean {
  const s = `${id} ${label ?? ''}`.toLowerCase();
  return DEPRECATED_PATTERNS.some(p => p.test(s));
}

/** Tier sort order in the shortlist. */
const TIER_ORDER: Record<DiscoveryTier, number> = {
  flagship: 0,
  balanced: 1,
  reasoning: 2,
  cheap: 3,
  embedding: 4,
  other: 5,
};

interface CurateOpts {
  /** Show preview/experimental models even though they're hidden by default. */
  includePreview?: boolean;
  /** Include embedding/non-chat in the shortlist. */
  includeNonChat?: boolean;
  /** Cap shortlist size. Default: unlimited (curation already filters aggressively). */
  limit?: number;
}

/**
 * Apply curation rules to a fresh provider model list and return a CuratedSet.
 * Source is set by the caller (live | cache | unconfigured).
 */
export function curate(
  models: CanonicalModel[],
  source: CuratedSet['source'],
  lastFetched = Date.now(),
  opts: CurateOpts = {},
): CuratedSet {
  const total = models.length;
  const now = Date.now();

  // 1. Drop deprecated unless vendor flagged it explicitly.
  // 2. Drop non-chat unless caller asked for it.
  // 3. Drop preview unless caller asked.
  // 4. If a `createdAt` is present, drop anything older than the recency window.
  const filtered = models.filter(m => {
    if (m.isDeprecated || looksDeprecated(m.id, m.label)) return false;
    if (!opts.includeNonChat && (isNonChat(m.id) && m.tier !== 'embedding')) return false;
    if (!opts.includeNonChat && m.tier === 'embedding') return false;
    if (!opts.includePreview && (m.isPreview || looksPreview(m.id, m.label))) return false;
    if (m.createdAt && now - m.createdAt > RECENCY_WINDOW_MS) return false;
    // Tool-use gate when the vendor exposes the flag.
    if (m.supportsTools === false) return false;
    return true;
  });

  // De-duplicate dated snapshots when an alias variant exists for the same root.
  // e.g. drop `claude-sonnet-4-5-20250929` if `claude-sonnet-4-5` is present.
  const ids = new Set(filtered.map(m => m.id));
  const deduped = filtered.filter(m => {
    const datedMatch = m.id.match(/^(.+?)-\d{4,8}(-\d{2,4})?$/);
    if (!datedMatch) return true;
    const root = datedMatch[1];
    return !ids.has(root);
  });

  // Sort: tier asc, then createdAt desc (newest first within a tier).
  deduped.sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (t !== 0) return t;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });

  const shortlist = opts.limit ? deduped.slice(0, opts.limit) : deduped;

  return {
    shortlist,
    hiddenCount: total - shortlist.length,
    lastFetched,
    source,
  };
}

/** Apply tier inference to a partially-filled CanonicalModel batch. */
export function applyTierInference(models: Omit<CanonicalModel, 'tier'>[]): CanonicalModel[] {
  return models.map(m => ({ ...m, tier: inferTier(m.id, m.label) }));
}
