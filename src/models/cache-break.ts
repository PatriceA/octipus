/**
 * Why a conversation's cached prompt prefix was lost between two requests.
 *
 * Provider prompt caches are prefix-addressed, so a request reads back what
 * the previous one wrote only when everything before its breakpoint is byte
 * for byte the same: the model, the tool list in order, the system prompt.
 * `prefixSignature` captures exactly that (order-sensitive, unlike the
 * signed-reasoning fingerprint, for which a reordered tool set is no change).
 * `classifyCacheBreak` compares two consecutive requests and names the cause,
 * so a regression — a tool group that started varying, a system block that
 * picked up per-turn text — shows up in the logs and the
 * `octipus_prompt_cache_breaks_total` metric instead of only on the bill.
 */
import { createHash } from 'node:crypto';

export interface PrefixSignature {
  model: string;
  tools: string;
  system: string;
}

export interface CacheProbe extends PrefixSignature {
  /** When the request was sent. */
  at: number;
  /** Prompt tokens the provider reported for it. */
  inputTokens: number;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

export function prefixSignature(model: string, tools: unknown[] | undefined, systemMessages: string[]): PrefixSignature {
  return { model, tools: hash(tools ?? []), system: hash(systemMessages) };
}

export type CacheBreakCause = 'model_changed' | 'tools_changed' | 'system_changed' | 'unexplained_miss';

/**
 * Providers that report cache reads on every response, so an absent count
 * means zero read back (`normalizeUsage` omits a zero).
 */
const REPORTS_CACHE_READS = new Set(['anthropic', 'custom-anthropic', 'openai', 'deepseek', 'gemini', 'openrouter', 'grok', 'moonshot', 'zai', 'mistral', 'meta']);

/** Below this a provider may not cache at all (minimum cacheable prefix). */
const MIN_PREFIX_TOKENS = 2048;
/** Shortest provider cache lifetime: past it a miss is expiry, not a break. */
const SHORTEST_TTL_MS = 5 * 60_000;

export function classifyCacheBreak(
  previous: CacheProbe | undefined,
  current: PrefixSignature & { at: number },
  usage: { cacheReadTokens?: number },
  provider: string,
): CacheBreakCause | undefined {
  if (!previous) return undefined;
  if (previous.model !== current.model) return 'model_changed';
  if (previous.tools !== current.tools) return 'tools_changed';
  if (previous.system !== current.system) return 'system_changed';
  if (!REPORTS_CACHE_READS.has(provider)) return undefined;
  if (previous.inputTokens < MIN_PREFIX_TOKENS || current.at - previous.at > SHORTEST_TTL_MS) return undefined;
  // The whole previous prompt is a prefix of this one within a conversation;
  // reading back under half of it on an unchanged prefix is a lost cache.
  return (usage.cacheReadTokens ?? 0) < previous.inputTokens / 2 ? 'unexplained_miss' : undefined;
}
