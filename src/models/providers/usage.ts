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
 * Stable, opaque prompt-cache affinity key derived from a session id. Providers
 * that route requests to a cached prefix by key (Mistral `prompt_cache_key`,
 * Grok `x-grok-conv-id`) get better hit rates when same-session requests share
 * one. Hashed so no raw session id / PII leaves the process.
 */
export function cacheAffinityKey(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  // djb2 — cheap, non-crypto; we only need a stable opaque token, not security.
  let h = 5381;
  for (let i = 0; i < sessionId.length; i++) h = ((h << 5) + h + sessionId.charCodeAt(i)) | 0;
  return `octi-${(h >>> 0).toString(36)}`;
}
