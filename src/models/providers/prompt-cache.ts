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

/** Cache-breakpoint content block. `cache_control` is an Anthropic pass-through
 * field the OpenAI SDK types don't model; the volatile block omits it. */
type CachedBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Build the [static (cached), volatile (uncached)] content blocks for a split.
 * The ONE source of the block shape — both the native `system` array
 * (buildCachedSystem) and the OpenAI-compat message content (below) use it, so
 * the two wire shapes can't drift out of lockstep.
 */
export function buildCachedBlocks(split: { staticPart: string; volatilePart: string }): CachedBlock[] {
  const blocks: CachedBlock[] = [{ type: 'text', text: split.staticPart, cache_control: { type: 'ephemeral' } }];
  if (split.volatilePart) blocks.push({ type: 'text', text: split.volatilePart });
  return blocks;
}

/**
 * True when a model routes to an Anthropic upstream — the only family whose
 * OpenAI-compat endpoints (via LiteLLM / OpenRouter) honor `cache_control`
 * content blocks. Heuristic: "claude" in an id is effectively always Anthropic,
 * and "anthropic/" is the provider path segment. Deliberately does NOT match a
 * bare "anthropic" elsewhere in the id (e.g. an "anthropic-gateway/llama" alias
 * pointing at a non-Anthropic backend), which would otherwise get cache_control
 * blocks a strict upstream 400s on. An Anthropic model aliased without either
 * token just misses the breakpoint (same as before) — a safe false negative.
 */
export function isAnthropicFamily(model: string): boolean {
  return /claude/i.test(model) || /(^|\/)anthropic\//i.test(model);
}

/**
 * Rewrite the FIRST system message that spans the static/volatile boundary into
 * OpenAI-style content blocks carrying an Anthropic `cache_control` ephemeral
 * breakpoint. Mutates `messages` in place; a no-op (leaves the plain string)
 * when nothing is cacheable. Only the first splittable system message is marked
 * — one breakpoint is all the assembled prompt needs, and it keeps us well
 * under Anthropic's 4-breakpoint cap even if a request carries several system
 * turns. Only call this for Anthropic-family models — other upstreams may
 * reject the field. Returns true if a breakpoint was applied (used by tests;
 * callers may log it).
 */
export function applyAnthropicCacheControl(messages: ChatCompletionMessageParam[]): boolean {
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
    const split = splitVolatileSystem(msg.content);
    if (!split) continue;
    (msg as { content: unknown }).content = buildCachedBlocks(split);
    return true;
  }
  return false;
}
