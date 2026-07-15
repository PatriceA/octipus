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
        prompt_cache_hit_tokens?: number;
      }
    | undefined;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens;
  return cached != null && cached > 0 ? { cacheReadTokens: cached } : {};
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
