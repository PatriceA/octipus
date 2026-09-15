import { describe, expect, it, vi } from 'vitest';

/**
 * A CLI completion spawns a real agent process. Without a cap, a background
 * fan-out (one abstract per indexed chunk) spawned 40+ in parallel and wedged
 * the host. The gate must never let more than MAX run at once.
 */
describe('CLI concurrency gate', () => {
  it('admits at most OCTIPUS_CLI_MAX_CONCURRENT runners and hands the slot on', async () => {
    vi.resetModules();
    process.env.OCTIPUS_CLI_MAX_CONCURRENT = '2';
    const { acquireCliSlot } = await import('./cli-provider');

    let running = 0;
    let peak = 0;
    const run = async () => {
      const release = await acquireCliSlot();
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      release();
    };

    await Promise.all(Array.from({ length: 10 }, run));
    expect(peak).toBe(2);
    expect(running).toBe(0);
  });
});
