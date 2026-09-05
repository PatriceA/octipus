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
// prompt-assembly sites (worker-spawner, root-runner) push the date
// block first into the volatile tier (Phase 2a), so the static/cacheable prefix
// is everything before this marker.
export const VOLATILE_MARKER = /\n\nCURRENT DATE ?&? ?\/?\s?TIME/;
// Default floor ≈ 1024 tokens at ~4 chars/token; below the per-model minimum a
// breakpoint is a silent no-op (cache_creation_input_tokens stays 0), so don't
// bother marking one. Kept exported for tests/back-compat; prefer
// minCacheableChars(model) which knows the per-model minimums.
export const MIN_CACHEABLE_CHARS = 4000;

/**
 * Anthropic's minimum cacheable prefix is MODEL-dependent (per current docs):
 * Opus 4.x + Haiku 4.5 need 4096 tokens, Fable/Mythos 5 + Sonnet 4.6 + Haiku 3.x
 * need 2048, Sonnet 4.5-class models 1024. Below the minimum the breakpoint is
 * silently ignored, so marking one only spends the cache-write premium chance
 * for nothing. Chars ≈ tokens × 4 (repo-wide heuristic).
 */
export function minCacheableChars(model?: string): number {
  const m = (model || '').toLowerCase();
  if (/opus-4|haiku-4/.test(m)) return 16_384; // 4096 tok
  // Haiku 3.x ids are `claude-3-haiku-*` / `claude-3-5-haiku-*` (family digit
  // BEFORE the name), so match both orderings.
  if (/fable|mythos|sonnet-4-6|haiku-3|3(-5)?-haiku/.test(m)) return 8_192; // 2048 tok
  // 1024 tok — Sonnet 4.5-class, and the deliberate fall-through for unknown
  // or aliased ids (custom endpoints, LiteLLM aliases, future models): a
  // breakpoint below a model's real minimum is a free no-op (Anthropic just
  // ignores it — no write premium is charged unless it actually caches),
  // whereas defaulting HIGH would forfeit real caching on every 1024-tok
  // model. Lowest floor is the safe default.
  return MIN_CACHEABLE_CHARS;
}

/**
 * Split an assembled system prompt at the volatile marker. Returns null when
 * there's no marker or the static prefix is too small to be worth caching — the
 * caller then sends the prompt unsplit. Pass the model id so the per-model
 * cache minimum applies; without it the (lowest) default floor is used.
 */
export function splitVolatileSystem(system: string, model?: string): { staticPart: string; volatilePart: string } | null {
  const m = system.match(VOLATILE_MARKER);
  if (!m || m.index === undefined || m.index < minCacheableChars(model)) return null;
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
export function applyAnthropicCacheControl(messages: ChatCompletionMessageParam[], model?: string): boolean {
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
    const split = splitVolatileSystem(msg.content, model);
    if (!split) continue;
    (msg as { content: unknown }).content = buildCachedBlocks(split);
    return true;
  }
  return false;
}
