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
  const inputTokens = count(raw?.prompt_tokens ?? raw?.input_tokens);
  const outputTokens = count(raw?.completion_tokens ?? raw?.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: count(raw?.total_tokens ?? inputTokens + outputTokens),
    available: [raw?.prompt_tokens, raw?.input_tokens, raw?.completion_tokens, raw?.output_tokens, raw?.total_tokens].some(v => typeof v === 'number' && Number.isFinite(v) && v >= 0),
    ...extractCachedTokens(raw),
    cacheCreationTokens: count(raw?.prompt_tokens_details?.cache_write_tokens ?? raw?.input_tokens_details?.cache_write_tokens),
    reasoningTokens: count(raw?.completion_tokens_details?.reasoning_tokens ?? raw?.output_tokens_details?.reasoning_tokens),
    ...(typeof raw?.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? { reportedCost: raw.cost } : {}),
  };
}
