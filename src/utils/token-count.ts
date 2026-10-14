import { createRequire } from 'node:module';
import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';
import { coreLogger } from '@/utils/logger';

// Real BPE tokenizer for budget estimation. o200k_base is the GPT-4o/o-series
// vocabulary — the best single default across providers; true per-request
// counts still come from provider `usage`. Lazily built and memoized. Falls
// back to chars/4 if the encoder can't load (exotic runtime).
//
// The rank table is required on first use from `js-tiktoken/lite` + its own
// ranks file. The package root bundles every encoding (gpt2 … o200k, ~5.5 MB
// of source) and, imported statically, was parsed on every boot whether or
// not anything counted a token.
//
// Standalone (only js-tiktoken + logger) so budget-aware call sites — context
// compaction, memory injection, summarizer chunking — can import it without
// pulling in the model-registry/litellm dependency chain.
const requireRanks = createRequire(import.meta.url);
let encoder: Tiktoken | null | undefined;
function getEncoder(): Tiktoken | null {
  if (encoder === undefined) {
    try {
      const mod = requireRanks('js-tiktoken/ranks/o200k_base') as { default?: TiktokenBPE } & TiktokenBPE;
      encoder = new Tiktoken(mod.default ?? mod);
    } catch (err) {
      coreLogger.warn({ err }, 'tiktoken encoder unavailable — falling back to chars/4');
      encoder = null;
    }
  }
  return encoder;
}

// Callers re-estimate the same (often large, append-only) strings repeatedly,
// so encoding is memoized by content string — unchanged text becomes a cache
// hit and only new text is BPE-encoded. The keys ARE the strings, so the cache
// is bounded by their total length as well as their number (4096 history-sized
// keys could otherwise pin hundreds of MB); least recently used goes first.
const tokenCache = new Map<string, number>();
const TOKEN_CACHE_MAX = 4096;
const TOKEN_CACHE_MAX_CHARS = 16 * 1024 * 1024;
let tokenCacheChars = 0;

/**
 * Estimate token count for a string using the o200k_base tokenizer, with a
 * chars/4 fallback. Used for pre-flight budgeting/compaction only — provider
 * `usage` remains ground truth for billing.
 */
// Only strings this long are worth a cache slot: short, frequently-changing
// strings (e.g. per-turn memory lines) encode in microseconds and would only
// evict the large append-only history entries the cache exists to serve.
const TOKEN_CACHE_MIN_LEN = 512;

export function estimateTokens(content: string): number {
  if (!content) return 0;
  const cacheable = content.length >= TOKEN_CACHE_MIN_LEN;
  if (cacheable) {
    const cached = tokenCache.get(content);
    if (cached !== undefined) {
      tokenCache.delete(content);
      tokenCache.set(content, cached);
      return cached;
    }
  }

  let count: number;
  const enc = getEncoder();
  if (enc) {
    try {
      count = enc.encode(content).length;
    } catch {
      count = Math.ceil(content.length / 4);
    }
  } else {
    count = Math.ceil(content.length / 4);
  }

  // A string too big to share the budget with others is counted, not kept.
  if (cacheable && content.length <= TOKEN_CACHE_MAX_CHARS / 8) {
    while (tokenCache.size >= TOKEN_CACHE_MAX || (tokenCache.size > 0 && tokenCacheChars + content.length > TOKEN_CACHE_MAX_CHARS)) {
      const oldest = tokenCache.keys().next().value as string;
      tokenCache.delete(oldest);
      tokenCacheChars -= oldest.length;
    }
    tokenCache.set(content, count);
    tokenCacheChars += content.length;
  }
  return count;
}

const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Truncate text so the result — INCLUDING the truncation marker — is at most
 * `budget` tokens. Used to bound per-section context injections (AGENTS.md
 * guides, indexes, maps) so one oversized section can't blow the prompt budget.
 * Cuts on real token boundaries (encode → slice ids → decode), so it never
 * exceeds the budget and never splits a surrogate pair. Falls back to a chars/4
 * cut only if the encoder can't load.
 */
export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  const enc = getEncoder();
  if (!enc) {
    // Encoder unavailable: approximate with chars/4, leaving room for the marker.
    if (Math.ceil(text.length / 4) <= budget) return text;
    const keepChars = Math.max(0, (budget - 4) * 4);
    return `${text.slice(0, keepChars).trimEnd()}${TRUNCATION_MARKER}`;
  }
  const ids = enc.encode(text);
  if (ids.length <= budget) return text;
  // Reserve the marker's tokens so the TOTAL stays within budget.
  const markerTokens = enc.encode(TRUNCATION_MARKER).length;
  const keep = Math.max(0, budget - markerTokens);
  return `${enc.decode(ids.slice(0, keep)).trimEnd()}${TRUNCATION_MARKER}`;
}

/**
 * Keep whole lines from `lines` (already ordered highest-value first) until the
 * running token total would exceed `budget`, then stop. Unlike truncateToTokens
 * this never cuts mid-line — used for indexes/maps where each line ends in a
 * token that must survive intact (an `expertId`, an absolute repo path). Returns
 * the kept lines and whether any were dropped, so the caller can append its own
 * "…truncated" note in the block's own idiom.
 *
 * ALWAYS keeps at least the first (highest-value) line, even if it alone exceeds
 * the budget: a caller that renders a header promising N entries and instructs
 * the model to route by an id/path must never be handed an empty list.
 * ponytail: a single line larger than `budget` still ships whole (over budget);
 * upgrade = a per-entry cap at the render site if that ever bites in practice.
 */
export function truncateLinesToTokens(
  lines: string[],
  budget: number,
): { lines: string[]; truncated: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    // Charge the joining newline only BETWEEN lines: N lines have N-1 newlines.
    const cost = estimateTokens(line) + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget && kept.length > 0) return { lines: kept, truncated: true };
    used += cost;
    kept.push(line);
  }
  return { lines: kept, truncated: false };
}
