import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { modelLogger } from '@/utils/logger';

// ponytail: dedupe "missed a cache split" debug logs per model, same pattern as
// cost-tracker.ts's warnedMissingCachePricing. Key space bounded by distinct
// model ids seen — small, unbounded growth acceptable.
const loggedMissedSplit = new Set<string>();

export function __resetMissedCacheSplitLogs() {
  loggedMissedSplit.clear();
}

/** Log missing system breakpoints once per model. Usage determines actual hits. */
export function logMissedCacheSplit(model: string): void {
  if (loggedMissedSplit.has(model)) return;
  loggedMissedSplit.add(model);
  modelLogger.debug({ model }, 'Anthropic cache split missed — no breakpoint placed');
}

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
/** Split stable instructions from turn context. Provider eligibility includes tools. */
export function splitVolatileSystem(system: string, _model?: string): { staticPart: string; volatilePart: string } | null {
  const m = system.match(VOLATILE_MARKER);
  if (!m || m.index === undefined) return system.trim() ? { staticPart: system, volatilePart: '' } : null;
  if (m.index === 0) return null;
  return { staticPart: system.slice(0, m.index), volatilePart: system.slice(m.index) };
}

/**
 * Cache lifetime for an Anthropic breakpoint: the default five minutes, or an
 * hour. `cachePolicy: 'session'` (a model setting) asks for the hour: a write
 * costs 2x instead of 1.25x, and the entry survives the gaps between a user's
 * messages in a long session, where five minutes expires between turns.
 */
export type CacheTtl = '1h' | undefined;

export function cacheTtlFor(policy: 'default' | 'off' | 'session' | undefined): CacheTtl {
  return policy === 'session' ? '1h' : undefined;
}

/** The `cache_control` marker. Every breakpoint of a request gets the same TTL:
 * Anthropic requires longer-lived entries to come before shorter ones. */
export function cacheControl(ttl?: CacheTtl): { type: 'ephemeral'; ttl?: '1h' } {
  return ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

/** Cache-breakpoint content block. `cache_control` is an Anthropic pass-through
 * field the OpenAI SDK types don't model; the volatile block omits it. */
type CachedBlock = { type: 'text'; text: string; cache_control?: ReturnType<typeof cacheControl> };

/**
 * Build the [static (cached), volatile (uncached)] content blocks for a split.
 * The ONE source of the block shape — both the native `system` array
 * (buildCachedSystem) and the OpenAI-compat message content (below) use it, so
 * the two wire shapes can't drift out of lockstep.
 */
export function buildCachedBlocks(split: { staticPart: string; volatilePart: string }, ttl?: CacheTtl): CachedBlock[] {
  const blocks: CachedBlock[] = [{ type: 'text', text: split.staticPart, cache_control: cacheControl(ttl) }];
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
export function applyAnthropicCacheControl(
  messages: ChatCompletionMessageParam[],
  model?: string,
  opts?: { conversation?: boolean; history?: boolean; ttl?: CacheTtl },
): { system: boolean; history: boolean } {
  let system = false;
  for (const msg of messages) {
    if (msg.role !== 'system' || typeof msg.content !== 'string') continue;
    const split = splitVolatileSystem(msg.content, model);
    if (!split) continue;
    (msg as { content: unknown }).content = buildCachedBlocks(split, opts?.ttl);
    system = true;
    break;
  }

  // Write through the latest eligible input so the next request can reuse it.
  // The new suffix is charged on a miss; matching earlier prefixes can still hit.
  //
  // Only for a request that belongs to an ongoing conversation (`conversation`
  // — an agent turn or tool loop). A cache WRITE costs 1.25x base input, so
  // marking the newest turn is a surcharge unless a later request reads it
  // back. A one-shot utility completion has no later request, so it stops at
  // the settled history the way this did before — which for a 1-message
  // one-shot means no second breakpoint at all.
  let history = false;
  for (let i = opts?.history === false ? -1 : messages.length - (opts?.conversation ? 1 : 2); i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string') {
      (msg as { content: unknown }).content = [{ type: 'text', text: msg.content, cache_control: cacheControl(opts?.ttl) }];
      history = true;
      break;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      // Already content blocks (multimodal turn) — mark the last one, same as
      // the native path does.
      const lastIndex = msg.content.length - 1;
      (msg as { content: unknown }).content = msg.content.map((block, index) => index === lastIndex
        ? { ...block, cache_control: cacheControl(opts?.ttl) } : block);
      history = true;
      break;
    }
    // `content: null` — an assistant turn that is nothing but `tool_calls`.
    // This used to `break`, and in an agent tool loop the second-to-last
    // message is exactly that, so the history breakpoint was never placed in
    // the one case it was built for. Keep walking back instead. (The native
    // path never had this bug.)
  }

  return { system, history };
}
