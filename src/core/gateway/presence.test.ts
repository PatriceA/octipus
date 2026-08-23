import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PresenceTracker } from './presence';
import type { ConnectionContext } from './protocol';

function makeContext(overrides?: Partial<ConnectionContext>): ConnectionContext {
  return {
    connectionId: 'conn-1',
    userId: 'user-1',
    clientType: 'webchat',
    trustLevel: 'user',
    ip: '127.0.0.1',
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
    eventSubscriptions: new Set(['*']),
    metadata: {},
    ...overrides,
  };
}

describe('PresenceTracker', () => {
  let tracker: PresenceTracker;

  beforeEach(() => {
    tracker = new PresenceTracker();
  });

  afterEach(() => {
    tracker.destroy();
  });

  test('track and get a connection', () => {
    tracker.track(makeContext());
    const entry = tracker.get('conn-1');
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe('user-1');
    expect(entry!.clientType).toBe('webchat');
  });

  test('getByUser returns all connections for a user', () => {
    tracker.track(makeContext({ connectionId: 'c1', userId: 'u1' }));
    tracker.track(makeContext({ connectionId: 'c2', userId: 'u1' }));
    tracker.track(makeContext({ connectionId: 'c3', userId: 'u2' }));

    expect(tracker.getByUser('u1')).toHaveLength(2);
    expect(tracker.getByUser('u2')).toHaveLength(1);
    expect(tracker.getByUser('u3')).toHaveLength(0);
  });

  test('remove stops tracking', () => {
    tracker.track(makeContext());
    tracker.remove('conn-1');
    expect(tracker.get('conn-1')).toBeUndefined();
  });

  test('touch updates lastActivityAt', () => {
    tracker.track(makeContext({ lastActivityAt: 1000 }));
    tracker.touch('conn-1');
    const entry = tracker.get('conn-1');
    expect(entry!.lastActivityAt).toBeGreaterThan(1000);
  });

  test('getAll returns all entries', () => {
    tracker.track(makeContext({ connectionId: 'c1' }));
    tracker.track(makeContext({ connectionId: 'c2' }));
    expect(tracker.getAll()).toHaveLength(2);
  });

  test('getStats computes correct counts', () => {
    tracker.track(makeContext({ connectionId: 'c1', userId: 'u1', clientType: 'webchat', trustLevel: 'user' }));
    tracker.track(makeContext({ connectionId: 'c2', userId: 'u1', clientType: 'tui', trustLevel: 'local' }));
    tracker.track(makeContext({ connectionId: 'c3', userId: 'u2', clientType: 'webchat', trustLevel: 'user' }));

    const stats = tracker.getStats();
    expect(stats.totalConnections).toBe(3);
    expect(stats.uniqueUsers).toBe(2);
    expect(stats.byClientType.webchat).toBe(2);
    expect(stats.byClientType.tui).toBe(1);
    expect(stats.byTrustLevel.user).toBe(2);
    expect(stats.byTrustLevel.local).toBe(1);
  });

  test('idle timeout callback fires for expired connections', () => {
    const timedOut: string[] = [];
    tracker.destroy(); // stop default tracker
    tracker = new PresenceTracker({
      onIdleTimeout: (id) => timedOut.push(id),
    });

    // webchat idle timeout is 30min — set lastActivity to 31min ago
    tracker.track(makeContext({
      connectionId: 'c1',
      clientType: 'webchat',
      lastActivityAt: Date.now() - 31 * 60_000,
    }));

    // TUI has no timeout
    tracker.track(makeContext({
      connectionId: 'c2',
      clientType: 'tui',
      lastActivityAt: Date.now() - 120 * 60_000,
    }));

    // Manually trigger idle check
    (tracker as any).checkIdleConnections();

    expect(timedOut).toContain('c1');
    expect(timedOut).not.toContain('c2'); // TUI has no timeout
  });

  test('destroy clears all entries', () => {
    tracker.track(makeContext());
    tracker.destroy();
    expect(tracker.getAll()).toHaveLength(0);
  });
});
