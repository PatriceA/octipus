import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { parseClientMessage, matchesPattern, PROTOCOL_VERSION } from './protocol';
import { GatewayRateLimiter } from './rate-limiter';
import { GatewayEventBus } from './event-bus';
import type { GatewayEvent } from './protocol';

// ── Protocol Tests ────────────────────────────────────────────────

describe('Gateway Protocol', () => {
  describe('parseClientMessage', () => {
    test('parses valid auth message', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'auth',
        method: 'session_token',
        credentials: { token: 'abc123' },
        clientType: 'webchat',
      }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message.type).toBe('auth');
      }
    });

    test('parses valid chat.send message', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'Hello world',
      }));
      expect(result.ok).toBe(true);
    });

    test('parses valid command message', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'command',
        name: 'expert',
        args: { name: 'researcher' },
      }));
      expect(result.ok).toBe(true);
    });

    test('parses ping message', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'ping' }));
      expect(result.ok).toBe(true);
    });

    test('rejects invalid JSON', () => {
      const result = parseClientMessage('not json');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid JSON');
    });

    test('rejects unknown message type', () => {
      const result = parseClientMessage(JSON.stringify({ type: 'unknown_type' }));
      expect(result.ok).toBe(false);
    });

    test('rejects chat.send with empty content', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: '',
      }));
      expect(result.ok).toBe(false);
    });

    test('rejects chat.send with invalid sessionId', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: 'not-a-uuid',
        content: 'hello',
      }));
      expect(result.ok).toBe(false);
    });

    test('rejects auth with invalid method', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'auth',
        method: 'invalid_method',
        credentials: {},
        clientType: 'webchat',
      }));
      expect(result.ok).toBe(false);
    });

    test('parses subscribe message', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'subscribe',
        patterns: ['agent.*', 'chat.message'],
      }));
      expect(result.ok).toBe(true);
    });

    test('rejects subscribe with empty patterns', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'subscribe',
        patterns: [],
      }));
      expect(result.ok).toBe(false);
    });
  });

  describe('matchesPattern', () => {
    test('exact match', () => {
      expect(matchesPattern('agent.spawned', 'agent.spawned')).toBe(true);
    });

    test('no match on different type', () => {
      expect(matchesPattern('agent.spawned', 'chat.message')).toBe(false);
    });

    test('wildcard matches everything', () => {
      expect(matchesPattern('agent.spawned', '*')).toBe(true);
      expect(matchesPattern('chat.message', '*')).toBe(true);
    });

    test('prefix wildcard matches', () => {
      expect(matchesPattern('agent.spawned', 'agent.*')).toBe(true);
      expect(matchesPattern('agent.completed', 'agent.*')).toBe(true);
    });

    test('prefix wildcard does not match different prefix', () => {
      expect(matchesPattern('chat.message', 'agent.*')).toBe(false);
    });

    test('prefix wildcard does not match partial prefix', () => {
      expect(matchesPattern('agentfoo', 'agent.*')).toBe(false);
    });
  });

  test('protocol version is defined', () => {
    expect(PROTOCOL_VERSION).toBe('1.0');
  });
});

// ── Rate Limiter Tests ────────────────────────────────────────────

describe('GatewayRateLimiter', () => {
  let limiter: GatewayRateLimiter;

  beforeEach(() => {
    limiter = new GatewayRateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  test('allows requests under limit', () => {
    const result = limiter.check('conn1', 'chat.send', 'user');
    expect(result.allowed).toBe(true);
  });

  test('blocks requests over limit', () => {
    // User limit for chat.send is 30/min
    for (let i = 0; i < 30; i++) {
      const r = limiter.check('conn1', 'chat.send', 'user');
      expect(r.allowed).toBe(true);
    }
    // 31st should be blocked
    const result = limiter.check('conn1', 'chat.send', 'user');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test('different connections have independent limits', () => {
    for (let i = 0; i < 30; i++) {
      limiter.check('conn1', 'chat.send', 'user');
    }
    // conn1 is exhausted
    expect(limiter.check('conn1', 'chat.send', 'user').allowed).toBe(false);
    // conn2 is fresh
    expect(limiter.check('conn2', 'chat.send', 'user').allowed).toBe(true);
  });

  test('different actions have independent limits', () => {
    for (let i = 0; i < 30; i++) {
      limiter.check('conn1', 'chat.send', 'user');
    }
    // chat.send exhausted, command should still work
    expect(limiter.check('conn1', 'command', 'user').allowed).toBe(true);
  });

  test('system trust level has higher limits', () => {
    // System limit for chat.send is 200/min
    for (let i = 0; i < 200; i++) {
      const r = limiter.check('conn1', 'chat.send', 'system');
      expect(r.allowed).toBe(true);
    }
    expect(limiter.check('conn1', 'chat.send', 'system').allowed).toBe(false);
  });

  test('getUsage returns correct count', () => {
    for (let i = 0; i < 5; i++) {
      limiter.check('conn1', 'chat.send', 'user');
    }
    const usage = limiter.getUsage('conn1', 'chat.send', 'user');
    expect(usage.used).toBe(5);
    expect(usage.limit).toBe(30);
  });

  test('removeConnection clears state', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('conn1', 'chat.send', 'user');
    }
    limiter.removeConnection('conn1');
    const usage = limiter.getUsage('conn1', 'chat.send', 'user');
    expect(usage.used).toBe(0);
  });
});

// ── Event Bus Tests ───────────────────────────────────────────────

describe('GatewayEventBus', () => {
  let bus: GatewayEventBus;

  beforeEach(() => {
    bus = new GatewayEventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  function makeEvent(overrides?: Partial<GatewayEvent>): GatewayEvent {
    return {
      id: Math.random().toString(36),
      type: 'test.event',
      source: 'test',
      timestamp: Date.now(),
      payload: {},
      ...overrides,
    };
  }

  test('delivers events to subscribers', () => {
    const received: GatewayEvent[] = [];
    bus.subscribe('test.*', (e) => received.push(e));

    bus.publish(makeEvent({ type: 'test.event' }));
    expect(received).toHaveLength(1);
  });

  test('wildcard receives all events', () => {
    const received: GatewayEvent[] = [];
    bus.subscribe('*', (e) => received.push(e));

    bus.publish(makeEvent({ type: 'agent.spawned' }));
    bus.publish(makeEvent({ type: 'chat.message' }));
    expect(received).toHaveLength(2);
  });

  test('exact match subscription', () => {
    const received: GatewayEvent[] = [];
    bus.subscribe('agent.spawned', (e) => received.push(e));

    bus.publish(makeEvent({ type: 'agent.spawned' }));
    bus.publish(makeEvent({ type: 'agent.completed' }));
    expect(received).toHaveLength(1);
  });

  test('unsubscribe stops delivery', () => {
    const received: GatewayEvent[] = [];
    const unsub = bus.subscribe('*', (e) => received.push(e));

    bus.publish(makeEvent());
    expect(received).toHaveLength(1);

    unsub();
    bus.publish(makeEvent());
    expect(received).toHaveLength(1); // No new events
  });

  test('replay buffer stores events per session', () => {
    bus.publish(makeEvent({ sessionId: 'session1', id: 'e1' }));
    bus.publish(makeEvent({ sessionId: 'session1', id: 'e2' }));
    bus.publish(makeEvent({ sessionId: 'session2', id: 'e3' }));

    const replay1 = bus.getReplay('session1');
    expect(replay1).toHaveLength(2);

    const replay2 = bus.getReplay('session2');
    expect(replay2).toHaveLength(1);
  });

  test('replay after event ID', () => {
    bus.publish(makeEvent({ sessionId: 's1', id: 'e1' }));
    bus.publish(makeEvent({ sessionId: 's1', id: 'e2' }));
    bus.publish(makeEvent({ sessionId: 's1', id: 'e3' }));

    const replay = bus.getReplay('s1', 'e1');
    expect(replay).toHaveLength(2);
    expect(replay[0].id).toBe('e2');
  });

  test('replay buffer limits to maxReplayPerSession', () => {
    for (let i = 0; i < 250; i++) {
      bus.publish(makeEvent({ sessionId: 's1', id: `e${i}` }));
    }
    const replay = bus.getReplay('s1');
    expect(replay).toHaveLength(200);
  });

  test('clearReplay removes buffer', () => {
    bus.publish(makeEvent({ sessionId: 's1' }));
    bus.clearReplay('s1');
    expect(bus.getReplay('s1')).toHaveLength(0);
  });

  test('getStats returns correct counts', () => {
    bus.subscribe('agent.*', () => {});
    bus.subscribe('chat.*', () => {});
    bus.publish(makeEvent({ sessionId: 's1' }));
    bus.publish(makeEvent());

    const stats = bus.getStats();
    expect(stats.totalPublished).toBe(2);
    expect(stats.activeSubscriptions).toBe(2);
    expect(stats.replayBufferSessions).toBe(1);
  });

  test('handler errors do not break other handlers', () => {
    const received: string[] = [];
    bus.subscribe('*', () => { throw new Error('boom'); });
    bus.subscribe('*', (e) => received.push(e.id));

    bus.publish(makeEvent({ id: 'safe' }));
    expect(received).toEqual(['safe']);
  });
});
