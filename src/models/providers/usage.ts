import { createHash } from 'node:crypto';

/**
 * Normalize provider prompt-cache usage fields into CompletionResult.usage.
 *
 * OpenAI-compat providers (OpenAI, Grok, Mistral, Gemini-compat, OpenRouter)
 * report cached prompt tokens under `prompt_tokens_details.cached_tokens`, a
 * subset of `prompt_tokens`. DeepSeek reports its own hit/miss split. Anthropic
 * native (`cache_read_input_tokens`) is handled in its own provider.
 */
export function extractCachedTokens(rawUsage: unknown): {
  cacheReadTokens?: number;
} {
  const u = rawUsage as
    | {
        prompt_tokens_details?: { cached_tokens?: number };
        input_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      }
    | undefined;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.input_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens;
  return typeof cached === 'number' && Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {};
}

/**
 * Reconcile prompt-cache counters into one convention: `inputTokens` is the
 * grand total and the two cache figures are subsets of it.
 *
 * Providers disagree on whether counters are already included in the reported
 * total. Use field-name convention to determine inclusion semantics:
 *
 * - OpenAI-shaped fields are ALREADY INCLUDED in reported total:
 *   `prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`,
 *   `prompt_cache_hit_tokens`, `prompt_tokens_details.cache_write_tokens`,
 *   `input_tokens_details.cache_write_tokens`.
 * - Anthropic field names are EXCLUSIVE and must be added to the total:
 *   `cache_read_input_tokens`, `cache_creation_input_tokens`.
 *
 * Post-condition clamp ensures the invariant `read + write <= inputTokens`
 * holds: if counters sum beyond the calculated total, raise inputTokens to
 * that sum.
 */
export function foldCacheCounters(raw: unknown): {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens: number;
} {
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const u = raw as Record<string, any> | undefined;

  // Base reported count
  const reported = count(u?.prompt_tokens ?? u?.input_tokens);

  // Cache read: OpenAI-shaped (already included) takes precedence;
  // fall back to Anthropic name (exclusive, will be added).
  const readFromOpenAI = extractCachedTokens(raw).cacheReadTokens ?? 0;
  const readFromAnthropic = count(u?.cache_read_input_tokens);
  const cacheReadTokens = readFromOpenAI > 0 ? readFromOpenAI : readFromAnthropic;
  const readIsExclusive = readFromOpenAI === 0 && readFromAnthropic > 0;

  // Cache write: OpenAI-shaped (already included) takes precedence;
  // fall back to Anthropic name (exclusive, will be added).
  const writeFromOpenAI = count(
    u?.prompt_tokens_details?.cache_write_tokens
      ?? u?.input_tokens_details?.cache_write_tokens,
  );
  const writeFromAnthropic = count(u?.cache_creation_input_tokens);
  const cacheCreationTokens = writeFromOpenAI > 0 ? writeFromOpenAI : writeFromAnthropic;
  const writeIsExclusive = writeFromOpenAI === 0 && writeFromAnthropic > 0;

  // Start with reported (includes OpenAI-shaped counters).
  // Add exclusive Anthropic counters.
  let inputTokens = reported;
  if (readIsExclusive) {
    inputTokens += cacheReadTokens;
  }
  if (writeIsExclusive) {
    inputTokens += cacheCreationTokens;
  }

  // Post-condition clamp: ensure invariant holds.
  const totalCacheTokens = cacheReadTokens + cacheCreationTokens;
  if (totalCacheTokens > inputTokens) {
    inputTokens = totalCacheTokens;
  }

  return {
    inputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    cacheCreationTokens,
  };
}

/**
 * Stable, opaque prompt-cache affinity key derived from session + user id.
 * Providers that route requests to a cached prefix by key (Mistral
 * `prompt_cache_key`, Grok `x-grok-conv-id`) get better hit rates when
 * same-session requests share one. Hashed (SHA-256, 128-bit prefix) so no raw
 * id / PII leaves the process; salted with userId so distinct users can never
 * collide onto one another's cache-affinity key.
 */
export function cacheAffinityKey(
  sessionId: string | undefined,
  userId?: string,
  scope?: string,
): string | undefined {
  if (!sessionId) return undefined;
  const digest = createHash('sha256').update(`${userId ?? ''}:${sessionId}${scope ? `:${scope}` : ''}`).digest('hex');
  return `octi-${digest.slice(0, 32)}`;
}


/** Preserve billing details at the wire boundary, including a legitimate $0 charge. */
export function normalizeUsage(raw: any): import('../litellm-client').CompletionResult['usage'] {
  const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = foldCacheCounters(raw);
  const outputTokens = count(raw?.completion_tokens ?? raw?.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: count(raw?.total_tokens ?? inputTokens + outputTokens),
    available: [raw?.prompt_tokens, raw?.input_tokens, raw?.completion_tokens, raw?.output_tokens, raw?.total_tokens].some(v => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    cacheCreationTokens,
    reasoningTokens: count(raw?.completion_tokens_details?.reasoning_tokens ?? raw?.output_tokens_details?.reasoning_tokens),
    ...(typeof raw?.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? { reportedCost: raw.cost } : {}),
  };
}
