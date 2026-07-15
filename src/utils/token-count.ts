import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { coreLogger } from '@/utils/logger';

// Real BPE tokenizer for budget estimation. o200k_base is the GPT-4o/o-series
// vocabulary — the best single default across providers; true per-request
// counts still come from provider `usage`. Lazily built (rank load is ~ms) and
// memoized. Falls back to chars/4 if the encoder can't load (exotic runtime).
//
// Standalone (only js-tiktoken + logger) so budget-aware call sites — context
// compaction, memory injection, summarizer chunking — can import it without
// pulling in the model-registry/litellm dependency chain.
let encoder: Tiktoken | null | undefined;
function getEncoder(): Tiktoken | null {
  if (encoder === undefined) {
    try {
      encoder = getEncoding('o200k_base');
    } catch (err) {
      coreLogger.warn({ err }, 'tiktoken encoder unavailable — falling back to chars/4');
      encoder = null;
    }
  }
  return encoder;
}

// Callers re-estimate the same (often large, append-only) strings repeatedly,
// so encoding is memoized by content string — unchanged text becomes a cache
// hit and only new text is BPE-encoded. Bounded to cap memory; evicts oldest.
const tokenCache = new Map<string, number>();
const TOKEN_CACHE_MAX = 4096;

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
    if (cached !== undefined) return cached;
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

  if (cacheable) {
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      tokenCache.delete(tokenCache.keys().next().value as string);
    }
    tokenCache.set(content, count);
  }
  return count;
}

/**
 * Deterministically truncate text to approximately `budget` tokens, appending
 * an ellipsis marker when trimmed. Used to bound per-section context injections
 * (AGENTS.md guides, indexes, maps) so one oversized section can't blow the
 * prompt budget. Uses the section's own chars-per-token ratio for a
 * single-pass, encoder-free cut (estimate stays within a few % of the real
 * count for prose/markdown).
 */
export function truncateToTokens(text: string, budget: number): string {
  if (budget <= 0) return '';
  const tokens = estimateTokens(text);
  if (tokens <= budget) return text;
  const charsPerToken = text.length / tokens;
  const keep = Math.max(0, Math.floor(budget * charsPerToken));
  return `${text.slice(0, keep).trimEnd()}\n…[truncated to ~${budget} tokens]`;
}
