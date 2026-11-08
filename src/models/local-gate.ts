/**
 * Foreground priority on a local model runner.
 *
 * A local runner serves one model instance from one GPU. A background call
 * (a compaction map, memory extraction, an unattended heartbeat turn) sent
 * while the user's conversation is mid-turn takes that GPU and, with another
 * prompt, evicts the KV prefix the conversation's next request would have
 * reused — so the user's next token waits on a full re-prefill. Odysseus gates
 * its local endpoints the same way.
 *
 * Interactive calls never wait here. A background call to the same runner
 * waits until no interactive call is in flight and none ended in the last
 * `quietMs`; the wait is bounded, so background work is delayed, never
 * starved. Process-local by design: the runner it protects is a single host.
 */
import type { RequestPriority } from './rate-limiter';
import { modelLogger } from '@/utils/logger';

/** Providers whose calls go to a single local model instance. */
const GATED_PROVIDERS = new Set(['ollama']);

export const FOREGROUND_QUIET_MS = 5_000;
export const FOREGROUND_MAX_WAIT_MS = 10 * 60_000;

interface Foreground { active: number; lastEnd: number }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LocalModelGate {
  private runners = new Map<string, Foreground>();

  constructor(private readonly opts: { quietMs?: number; maxWaitMs?: number } = {}) {}

  private runner(key: string): Foreground {
    let fg = this.runners.get(key);
    if (!fg) { fg = { active: 0, lastEnd: 0 }; this.runners.set(key, fg); }
    return fg;
  }

  /**
   * Enter the runner for one call; returns the release to call when it ends.
   * `key` names the runner (provider + endpoint): two hosts are two GPUs.
   */
  async enter(key: string, priority: RequestPriority, signal?: AbortSignal): Promise<() => void> {
    const fg = this.runner(key);
    if (priority === 'interactive') {
      fg.active++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        fg.active = Math.max(0, fg.active - 1);
        fg.lastEnd = Date.now();
      };
    }
    const quietMs = this.opts.quietMs ?? FOREGROUND_QUIET_MS;
    const deadline = Date.now() + (this.opts.maxWaitMs ?? FOREGROUND_MAX_WAIT_MS);
    let waited = false;
    for (;;) {
      signal?.throwIfAborted();
      const quietFor = Date.now() - fg.lastEnd;
      if (fg.active === 0 && quietFor >= quietMs) break;
      if (Date.now() >= deadline) {
        modelLogger.warn({ runner: key }, 'Background model call waited the maximum for a quiet foreground; running now');
        break;
      }
      waited = true;
      await sleep(fg.active > 0 ? Math.min(250, quietMs) : Math.max(10, quietMs - quietFor));
    }
    if (waited) modelLogger.debug({ runner: key }, 'Background model call started after the foreground went quiet');
    return () => {};
  }
}

let gate: LocalModelGate | undefined;
export function getLocalModelGate(): LocalModelGate {
  return (gate ??= new LocalModelGate());
}

/** The gate key for a call, or undefined when the provider is not a local runner. */
export function localRunnerKey(provider: string, endpoint?: string): string | undefined {
  return GATED_PROVIDERS.has(provider) ? `${provider}:${endpoint ?? 'default'}` : undefined;
}
