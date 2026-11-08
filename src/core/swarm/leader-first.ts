/**
 * Leader-first fan-out: siblings that share a prompt prefix start after one of
 * them has written it to the provider cache.
 *
 * Children of one role, under one parent, on one model lane share the role
 * prompt and most of the tool block; the `child:<role>` cache scope exists so
 * they land on the same cache. But a fan-out started them within milliseconds
 * of each other, before any one of them had been prefilled, so every sibling
 * missed and paid the cache write in full: four parallel researchers, four cold
 * prefixes. Hermes gates delegation the same way (`delegate_tool_prefix_gate`).
 *
 * So the first spawn of a family is its LEADER and starts at once; a sibling
 * that arrives while the leader is still being prefilled waits for the
 * leader's first streamed chunk — the point at which the provider has the
 * prefix — and then starts, reading it. The wait is capped (`WARM_WAIT_MS`):
 * a leader that never streams, fails or stalls holds nobody up for longer.
 * Once a family is warm, later siblings start immediately for `WARM_TTL_MS`,
 * the provider's shortest cache lifetime.
 *
 * The leader's worker learns it is one through AsyncLocalStorage
 * (`takeWarmSignal`): the spawn runs inside the leader's scope, and the first
 * worker started in it takes the signal and fires it on its first chunk.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Longest a sibling waits for its leader's prefix. */
export const WARM_WAIT_MS = 20_000;
/** How long a warmed family lets siblings start without a leader (Anthropic's 5m minimum). */
export const WARM_TTL_MS = 5 * 60_000;

interface Signal {
  fire: () => void;
  taken: boolean;
}

interface Family {
  warm: Promise<void>;
  warmAt?: number;
}

const leaderScope = new AsyncLocalStorage<Signal>();
const families = new Map<string, Family>();

/** The family a spawn belongs to: same parent, role and model lane share a prefix. */
export function prefixFamilyKey(parentId: string, role: string | undefined, topic: string | undefined): string {
  return `${parentId}\n${role ?? ''}\n${topic ?? ''}`;
}

/**
 * Run `start` as `key`'s leader, after its leader's prefix is warm, or at once
 * when the family is already warm. Always runs `start` exactly once.
 */
export async function leaderFirst<T>(key: string, start: () => Promise<T>, opts: { waitMs?: number; now?: () => number } = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  dropExpired(now());
  const family = families.get(key);
  if (family?.warmAt !== undefined) return start();
  if (family) {
    await waitAtMost(family.warm, opts.waitMs ?? WARM_WAIT_MS);
    return start();
  }
  let resolve!: () => void;
  const entry: Family = { warm: new Promise<void>((r) => { resolve = r; }) };
  families.set(key, entry);
  const signal: Signal = {
    taken: false,
    fire: () => {
      if (entry.warmAt !== undefined) return;
      entry.warmAt = now();
      resolve();
    },
  };
  try {
    return await leaderScope.run(signal, start);
  } finally {
    // Finished, failed or never streamed: nobody waits on it any longer.
    signal.fire();
  }
}

/**
 * For a worker starting a run: the leader signal of the spawn it belongs to,
 * once — the first worker of the scope takes it, so a retry's second worker and
 * the leader's own grandchildren (which open scopes of their own) do not.
 */
export function takeWarmSignal(): (() => void) | undefined {
  const signal = leaderScope.getStore();
  if (!signal || signal.taken) return undefined;
  signal.taken = true;
  return signal.fire;
}

function dropExpired(at: number): void {
  for (const [key, family] of families) {
    if (family.warmAt !== undefined && at - family.warmAt >= WARM_TTL_MS) families.delete(key);
  }
}

async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Test seam. */
export function resetLeaderFirst(): void {
  families.clear();
}
