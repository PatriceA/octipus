import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Shared Anthropic prompt-caching split. The native custom-anthropic provider
 * (Phase 2b) and the OpenAI-compat pass-through providers (LiteLLM, OpenRouter —
 * Phase A1) all cache the SAME static/volatile boundary of the assembled system
 * prompt; only the wire serialization differs (native `system` array vs
 * OpenAI-style message content blocks). This module owns the split so both
 * shapes stay in lockstep.
 */

// Marks the start of the VOLATILE section of an assembled system prompt. Both
// prompt-assembly sites (worker-spawner, orchestrator-runner) push the date
// block first into the volatile tier (Phase 2a), so the static/cacheable prefix
// is everything before this marker.
export const VOLATILE_MARKER = /\n\nCURRENT DATE ?&? ?\/?\s?TIME/;
// ~1024-token Anthropic cache minimum ≈ this many chars; below it a breakpoint
// is a no-op, so don't bother marking one.
export const MIN_CACHEABLE_CHARS = 4000;

/**
 * Split an assembled system prompt at the volatile marker. Returns null when
 * there's no marker or the static prefix is too small to be worth caching — the
 * caller then sends the prompt unsplit.
 */
export function splitVolatileSystem(system: string): { staticPart: string; volatilePart: string } | null {
  const m = system.match(VOLATILE_MARKER);
  if (!m || m.index === undefined || m.index < MIN_CACHEABLE_CHARS) return null;
  return { staticPart: system.slice(0, m.index), volatilePart: system.slice(m.index) };
}

/**
 * True when a model routes to an Anthropic upstream — the only family whose
 * OpenAI-compat endpoints (via LiteLLM / OpenRouter) honor `cache_control`
 * content blocks. Name-based: an Anthropic model aliased to something without
 * "claude"/"anthropic" in its id won't be detected (acceptable — it just
 * doesn't get the cache breakpoint, same as before).
 */
export function isAnthropicFamily(model: string): boolean {
  return /claude|anthropic/i.test(model);
}

/**
 * Rewrite any system message whose content spans the static/volatile boundary
 * into OpenAI-style content blocks carrying an Anthropic `cache_control`
 * ephemeral breakpoint at that boundary. Mutates `messages` in place; a no-op
 * (leaves the plain string) when the prompt has no cacheable split. Only call
 * this for Anthropic-family models — other upstreams may reject the field.
 * Returns true if a breakpoint was applied (for telemetry/tests).
 */
export function applyAnthropicCacheControl(messages: ChatCompletionMessageParam[]): boolean {
  let applied = false;
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
    const split = splitVolatileSystem(msg.content);
    if (!split) continue;
    // cache_control is an Anthropic pass-through field the OpenAI SDK/types
    // don't model, so build the blocks untyped and assign through a cast.
    (msg as { content: unknown }).content = [
      { type: 'text', text: split.staticPart, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: split.volatilePart },
    ];
    applied = true;
  }
  return applied;
}
