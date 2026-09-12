/**
 * Permission requests have no deadline: the agent waits as long as the human
 * needs. What used to happen instead — the 5-minute TTL firing while the user
 * was still reading the prompt, and the agent reporting the call "rejected,
 * expired, or undeliverable" — is the bug these pin shut.
 *
 * The only escape from an unanswered wait is the agent being stopped.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { auditRepository } from '@/db/repositories/audit-repository';
import { PermissionManager } from './permissions';

/**
 * The only DB touches on these paths are `expireRequest` (update…where) and
 * `approve` (update…where…returning).
 */
function stubDb(manager: PermissionManager, onExpire: () => void) {
  const row = { userId: 'u-1', sessionId: null, toolId: 'shell', action: 'run' };
  Object.defineProperty(manager, 'db', {
    configurable: true,
    get: () => ({
      insert: () => ({ values: async () => {} }),
      update: () => ({
        set: () => {
          const where = async () => { onExpire(); };
          where.returning = async () => [row];
          return { where: (...args: unknown[]) => Object.assign(where(...args as []), { returning: where.returning }) };
        },
      }),
    }),
  });
}

describe('waitForApproval', () => {
  afterEach(() => vi.restoreAllMocks());
  let manager: PermissionManager;
  let expired: number;

  beforeEach(() => {
    manager = new PermissionManager();
    expired = 0;
    stubDb(manager, () => { expired++; });
  });

  test('does not resolve on its own, however long the human takes', async () => {
    vi.useFakeTimers();
    try {
      let settled: boolean | 'pending' = 'pending';
      void manager.waitForApproval('req-1', { agentId: 'a-1' }).then((v) => { settled = v; });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // an hour
      expect(settled).toBe('pending');
      expect(expired).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('resolves when the request is answered', async () => {
    vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
    const pending = manager.waitForApproval('req-2', { agentId: 'a-1' });
    await manager.approve('req-2', 'u-1');
    expect(await pending).toBe(true);
  });

  test.each(['approve', 'deny'] as const)('%s settles its waiter even if the audit write fails', async (action) => {
    vi.spyOn(auditRepository, 'log').mockRejectedValue(new Error('audit unavailable'));
    const pending = manager.waitForApproval('audit-failure', { agentId: 'a-1' });
    expect(await manager[action]('audit-failure', 'u-1')).toBe(true);
    expect(await pending).toBe(action === 'approve');
  });

  test('stopping the agent releases its waits as unapproved, and expires them', async () => {
    const first = manager.waitForApproval('req-3', { agentId: 'a-1' });
    const second = manager.waitForApproval('req-4', { agentId: 'a-1' });
    const other = manager.waitForApproval('req-5', { agentId: 'a-2' });

    const seen: Array<[string, boolean]> = [];
    manager.onWaitStateChange((agentId, waiting) => seen.push([agentId, waiting]));

    expect(manager.cancelWaits('a-1')).toBe(2);
    // Exactly one "stopped waiting" for the agent, not one per released request.
    expect(seen).toEqual([['a-1', false]]);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    // One sweep for the agent, not one statement per request — and it covers
    // rows this process was never waiting on (a cross-process zombie's).
    expect(expired).toBe(1);

    // The other agent's wait is untouched.
    let otherSettled: boolean | 'pending' = 'pending';
    void other.then((v) => { otherSettled = v; });
    await Promise.resolve();
    expect(otherSettled).toBe('pending');
  });

  test('an explicit timeout is still honoured for a caller that asks for one', async () => {
    vi.useFakeTimers();
    try {
      let settled: boolean | 'pending' = 'pending';
      void manager.waitForApproval('req-6', { agentId: 'a-3', timeoutMs: 1000 }).then((v) => { settled = v; });
      await vi.advanceTimersByTimeAsync(1001);
      expect(settled).toBe(false);
      expect(expired).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a worker is told when its agent starts and stops waiting', async () => {
    const seen: Array<[string, boolean]> = [];
    const unsubscribe = manager.onWaitStateChange((agentId, waiting) => seen.push([agentId, waiting]));

    vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
    const pending = manager.waitForApproval('req-7', { agentId: 'a-4' });
    // A second wait for the same agent is not a second "started waiting".
    const alsoPending = manager.waitForApproval('req-8', { agentId: 'a-4' });
    await manager.approve('req-7', 'u-1');
    await pending;
    expect(seen).toEqual([['a-4', true]]);

    await manager.approve('req-8', 'u-1');
    await alsoPending;
    expect(seen).toEqual([['a-4', true], ['a-4', false]]);

    unsubscribe();
  });

  test('a restart releases requests nobody is waiting on any more', async () => {
    // Rows still 'pending' at boot belong to a process that is gone — with no
    // TTL they would otherwise replay into the UI forever.
    const released = await manager.releaseOrphanedRequests();
    expect(released).toBe(1); // the stub returns one row
    expect(expired).toBe(1);
  });
});


describe('approval creation cancellation races', () => {
  afterEach(() => vi.restoreAllMocks());

  test('audit failure during creation still returns an answerable request', async () => {
    const manager = new PermissionManager(); stubDb(manager, () => {});
    vi.spyOn(auditRepository, 'log').mockRejectedValue(new Error('audit unavailable'));
    const id = await manager.requestApproval('u-1', 'a-1', 'shell', 'run', {});
    const waiting = manager.waitForApproval(id, { agentId: 'a-1' });
    expect(await manager.approve(id, 'u-1')).toBe(true);
    expect(await waiting).toBe(true);
  });

  test('cancellation during the insert expires the request without installing a new waiter', async () => {
    const manager = new PermissionManager(); const controller = new AbortController();
    let expired = false;
    Object.defineProperty(manager, 'db', { get: () => ({
      insert: () => ({ values: async () => { controller.abort(); } }),
      update: () => ({ set: () => ({ where: async () => { expired = true; } }) }),
    }) });
    await expect(manager.requestApproval('u-1', 'a-1', 'shell', 'run', {}, undefined, undefined, controller.signal)).rejects.toThrow(/stopped/);
    expect(expired).toBe(true);
    expect(manager.cancelWaits('a-1')).toBe(0);
  });

  test('a cancellation before the caller starts waiting is retained and then cleaned up', async () => {
    const manager = new PermissionManager(); stubDb(manager, () => {});
    vi.spyOn(auditRepository, 'log').mockResolvedValue(undefined as never);
    const id = await manager.requestApproval('u-1', 'a-1', 'shell', 'run', {});
    expect(manager.cancelWaits('a-1')).toBe(1);
    expect(await manager.waitForApproval(id, { agentId: 'a-1' })).toBe(false);
    const internals = manager as unknown as { preparedWaits: Map<string, unknown>; pendingRequests: Map<string, unknown> };
    expect(internals.preparedWaits.size).toBe(0);
    expect(internals.pendingRequests.size).toBe(0);
  });
});
