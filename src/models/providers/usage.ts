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
 * Providers disagree on whether the counters are already included. Anthropic's
 * native endpoint reports `input_tokens` EXCLUSIVE of both cache figures;
 * OpenAI-compat bodies report `prompt_tokens` INCLUSIVE of
 * `prompt_tokens_details.cached_tokens`. Proxies (LiteLLM, OpenRouter) pass the
 * Anthropic names through on an otherwise OpenAI-shaped body, in either style.
 *
 * Rather than keying off the provider, detect it: counters that sum to more
 * than the reported input can only have been exclusive. That is the same
 * invariant `pricing.ts` refuses to cost, so folding here is what keeps cost
 * rows out of `unknown`.
 */
export function foldCacheCounters(raw: unknown): {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens: number;
} {
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const u = raw as Record<string, any> | undefined;

  const reported = count(u?.prompt_tokens ?? u?.input_tokens);
  const read = extractCachedTokens(raw).cacheReadTokens ?? count(u?.cache_read_input_tokens);
  const write = count(
    u?.cache_creation_input_tokens
      ?? u?.prompt_tokens_details?.cache_write_tokens
      ?? u?.input_tokens_details?.cache_write_tokens,
  );

  const inputTokens = read + write > reported ? reported + read + write : reported;
  return { inputTokens, ...(read > 0 ? { cacheReadTokens: read } : {}), cacheCreationTokens: write };
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
  userId?: string
): string | undefined {
  if (!sessionId) return undefined;
  const digest = createHash('sha256').update(`${userId ?? ''}:${sessionId}`).digest('hex');
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
