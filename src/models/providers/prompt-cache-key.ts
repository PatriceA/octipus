/**
 * OpenAI's `prompt_cache_key`: which requests are routed together to a cache.
 *
 * OpenAI routes a request by its key combined with a hash of the start of the
 * prompt, and documents two things about the key: it "separates cache reuse
 * between groups of requests", and one key past roughly 15 requests a minute
 * overflows onto further machines, which start cold.
 *
 * The key used to be derived from the user and session. Every session was then
 * its own group, so two conversations with the same tools and the same role
 * prompt — the bulk of the prefix: the root's tool JSON alone measured 73% of
 * its standing prompt — could never land on the machine that already held it.
 * A fresh session paid for the whole prefix even when a hundred others had just
 * sent it.
 *
 * So the key names the PREFIX FAMILY instead: model, agent kind (root, a child
 * role, a Companion path) and the declared tool names in order. Sessions that
 * share the expensive part of the prefix share a key. Sharing a key shares
 * nothing else: a hit needs a byte-identical prefix, so no session can reach
 * another's conversation through it, and nothing user- or session-derived is in
 * the key.
 *
 * Partitioned only above the documented rate. A family's sessions are split
 * into a power-of-two number of buckets by a stable hash of the session, sized
 * from the family's request rate over the last minute: doubling or halving the
 * count moves half the sessions, and a shrink waits `SHRINK_HOLD_MS` so a quiet
 * minute does not reshuffle a busy family.
 */

import { createHash } from 'node:crypto';

/** OpenAI's guidance: about this many requests a minute per key. */
export const REQUESTS_PER_MINUTE_PER_KEY = 15;
const WINDOW_MS = 60_000;
const SHRINK_HOLD_MS = 10 * 60_000;
const MAX_PARTITIONS = 64;
/** Families tracked before idle ones are dropped (one per model × kind × tool set). */
const MAX_FAMILIES = 512;

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The agent kind a `cacheScope` names, without its generation: `root:<gen>` is
 * `root`, `child:<role>` stays itself. A clear starts a new generation, which
 * resets the conversation's cache, not the family's prefix.
 */
export function scopeKind(cacheScope: string | undefined): string {
  if (!cacheScope) return 'root';
  return cacheScope.startsWith('child:') ? cacheScope : cacheScope.split(':')[0];
}

/** The tool names in declaration order: order is part of the prefix. */
function toolSignature(tools: readonly unknown[] | undefined): string {
  if (!tools?.length) return '';
  return tools.map((tool) => {
    const t = tool as { function?: { name?: string }; name?: string };
    return t.function?.name ?? t.name ?? '?';
  }).join(',');
}

export interface CacheKeyInputs {
  model: string;
  sessionId?: string;
  userId?: string;
  cacheScope?: string;
  tools?: readonly unknown[];
}

export class CacheKeyPartitioner {
  private families = new Map<string, { hits: number[]; partitions: number; changedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The key for one request, counted toward its family's rate. */
  key(inputs: CacheKeyInputs): string | undefined {
    if (!inputs.sessionId) return undefined;
    const family = digest(`${inputs.model}\n${scopeKind(inputs.cacheScope)}\n${toolSignature(inputs.tools)}`).slice(0, 24);
    const partitions = this.record(family);
    if (partitions === 1) return `octi-${family}`;
    const bucket = Number.parseInt(digest(`${inputs.userId ?? ''}:${inputs.sessionId}`).slice(0, 8), 16) % partitions;
    return `octi-${family}-${bucket}`;
  }

  /** How many partitions the family has after this request. */
  private record(family: string): number {
    const now = this.now();
    let state = this.families.get(family);
    if (!state) {
      if (this.families.size >= MAX_FAMILIES) this.dropIdle(now);
      state = { hits: [], partitions: 1, changedAt: now };
      this.families.set(family, state);
    }
    state.hits.push(now);
    while (state.hits.length && state.hits[0] <= now - WINDOW_MS) state.hits.shift();
    const wanted = Math.min(MAX_PARTITIONS, nextPowerOfTwo(Math.ceil(state.hits.length / REQUESTS_PER_MINUTE_PER_KEY)));
    if (wanted > state.partitions) {
      state.partitions = wanted;
      state.changedAt = now;
    } else if (wanted < state.partitions && now - state.changedAt >= SHRINK_HOLD_MS) {
      state.partitions = Math.max(wanted, state.partitions / 2);
      state.changedAt = now;
    }
    return state.partitions;
  }

  private dropIdle(now: number): void {
    for (const [family, state] of this.families) {
      const last = state.hits[state.hits.length - 1] ?? 0;
      if (now - last > SHRINK_HOLD_MS) this.families.delete(family);
    }
    // Still full: every family is busy. Drop the oldest; it re-forms at one partition.
    if (this.families.size >= MAX_FAMILIES) this.families.delete(this.families.keys().next().value as string);
  }
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

const shared = new CacheKeyPartitioner();

/** The process-wide partitioner's key for this request. */
export function promptCacheKey(inputs: CacheKeyInputs): string | undefined {
  return shared.key(inputs);
}
