/**
 * "Is it working or is it stuck?" — a worker in a legitimately-long wait must
 * say WHAT it is waiting for, because waiting-on-a-human, waiting-on-a-child
 * and waiting-on-a-slow-tool are all indistinguishable silence today.
 *
 * docs/plans/blocked-vs-stuck.md Phase 1.
 */
import { describe, expect, test } from 'vitest';
import { BLOCKED_PROGRESS_INTERVAL_MS, blockedReason, startBlockedHeartbeat } from './agent-worker';

describe('blockedReason', () => {
  test('names the human as the blocker for a final/approval tool', () => {
    expect(blockedReason([{ name: 'final' }], true, false)).toBe('awaiting your approval');
  });

  test('names children as the blocker for collect_children', () => {
    expect(blockedReason([{ name: 'collect_children' }], false, true)).toBe('waiting for spawned children to finish');
  });

  test('names the tool for an ordinary long call', () => {
    expect(blockedReason([{ name: 'shell__run' }], false, false)).toBe('running shell__run');
  });

  test('summarises a multi-tool batch and de-duplicates', () => {
    const r = blockedReason([{ name: 'a' }, { name: 'b' }, { name: 'a' }], false, false);
    expect(r).toBe('running 2 tools (a, b)');
  });
});

describe('startBlockedHeartbeat', () => {
  const collect = async (waitMs: number, intervalMs: number) => {
    const seen: Array<{ reason: string; blockedForMs: number }> = [];
    const stop = startBlockedHeartbeat('waiting for spawned children to finish', (p) => seen.push(p), intervalMs);
    await new Promise((r) => setTimeout(r, waitMs));
    stop();
    return seen;
  };

  test('a long wait reports at least once, naming the cause', async () => {
    // 3x the interval scaled down — the real 20s/30s ratio, in test time.
    const seen = await collect(75, 20);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].reason).toBe('waiting for spawned children to finish');
    expect(seen[0].blockedForMs).toBeGreaterThan(0);
  });

  test('a fast wait stays silent — no noise on normal runs', async () => {
    expect(await collect(10, 200)).toHaveLength(0);
  });

  test('stopping prevents any further reports', async () => {
    const seen: Array<unknown> = [];
    const stop = startBlockedHeartbeat('x', (p) => seen.push(p), 10);
    stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);
  });

  test('the shipped interval is a reporting cadence, not a deadline', () => {
    // Guards the intent: short enough to beat a human's "it hung" conclusion,
    // long enough that ordinary tool calls never emit.
    expect(BLOCKED_PROGRESS_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(BLOCKED_PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});
