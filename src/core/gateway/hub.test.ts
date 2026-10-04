/**
 * The hub's per-tab delivery (coworking S0d): the `permission.pending`
 * snapshot and the events held while it is read, `only`-narrowed events
 * (`voice.speak`), the per-user connection cap, and the replay buffers —
 * capped per process (LRU) and dropped when a session is deleted or archived.
 */
import { describe, expect, test } from 'vitest';
import { sessionsRemoved } from '@/db/repositories/session-lifecycle';
import { ConnectionManager } from './connection-manager';
import { GatewayEventBus } from './event-bus';
import { GatewayHub } from './hub';
import type { PermissionPendingMessage, UserGatewayEvent } from './protocol';

process.env.LOG_LEVEL ??= 'error';

type Frame = Record<string, any>;

function makeHub(): GatewayHub {
  const hub = new GatewayHub();
  hub.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
  hub.setWorkspaceResolver(async () => 'ws-1');
  return hub;
}

/** A signed-in, subscribed tab of `userId`. */
async function tab(hub: GatewayHub, userId: string, subscribe = true): Promise<{ id: string; frames: Frame[] }> {
  const frames: Frame[] = [];
  const ws = { data: {}, readyState: 1, send: (f: string) => frames.push(JSON.parse(f)), close: () => {} };
  const id = hub.connectionManager.handleOpen(ws, '127.0.0.1')!;
  await hub.connectionManager.handleMessage(id, JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: userId }, clientType: 'webchat' }));
  expect(frames.at(-1)).toMatchObject({ type: 'auth_ok', userId });
  if (subscribe) await hub.connectionManager.handleMessage(id, JSON.stringify({ type: 'subscribe', patterns: ['*'] }));
  return { id, frames };
}

const events = (frames: Frame[]) => frames.filter((f) => f.type === 'event').map((f) => f.event as UserGatewayEvent);

describe('permission.pending', () => {
  test('a tab opened after a request was raised gets it in its snapshot; another user gets theirs only', async () => {
    const hub = makeHub();
    hub.setPendingSnapshotProvider(async (userId) => userId === 'alice'
      ? { requests: [{ requestId: 'req-1', toolId: 'shell', action: 'execute', toolName: 'shell', args: {} }], approvals: [{ requestId: 'appr-1', sessionId: 's', summary: 'Deploy', question: 'Ship it?' }] }
      : { requests: [], approvals: [] });
    const alice = await tab(hub, 'alice');
    const bob = await tab(hub, 'bob');
    expect(alice.frames.find((f) => f.type === 'permission.pending')).toMatchObject({
      requests: [{ requestId: 'req-1' }], approvals: [{ requestId: 'appr-1' }],
    });
    expect(bob.frames.find((f) => f.type === 'permission.pending')).toEqual({ type: 'permission.pending', requests: [], approvals: [] });
  });

  test('a resolution during hydration follows the snapshot, and a request already in it is not sent twice', async () => {
    const hub = makeHub();
    let release!: (snapshot: Omit<PermissionPendingMessage, 'type'>) => void;
    hub.setPendingSnapshotProvider(() => new Promise((resolve) => { release = resolve; }));
    const alice = await tab(hub, 'alice', false);
    const subscribing = hub.connectionManager.handleMessage(alice.id, JSON.stringify({ type: 'subscribe', patterns: ['*'] }));
    await new Promise((r) => setImmediate(r));

    // Raised and resolved while the snapshot is read; an unrelated event is not held.
    hub.publishEvent({ type: 'permission.request', source: 't', userId: 'alice', payload: { requestId: 'req-1' } });
    hub.publishEvent({ type: 'permission.resolved', source: 't', userId: 'alice', payload: { requestId: 'req-1', status: 'expired' } });
    hub.publishEvent({ type: 'chat.delta', source: 't', userId: 'alice', payload: { delta: 'x' } });
    expect(events(alice.frames).map((e) => e.type)).toEqual(['chat.delta']);

    release({ requests: [{ requestId: 'req-1', toolId: 'shell', action: 'execute', toolName: 'shell', args: {} }], approvals: [] });
    await subscribing;
    const order = alice.frames.filter((f) => f.type !== 'auth_ok').map((f) => f.type === 'event' ? f.event.type : f.type);
    expect(order).toEqual(['chat.delta', 'permission.pending', 'permission.resolved']);
  });

  test('a failed snapshot is reported and the held events still delivered', async () => {
    const hub = makeHub();
    hub.setPendingSnapshotProvider(async () => { throw new Error('db down'); });
    const alice = await tab(hub, 'alice');
    expect(alice.frames.find((f) => f.type === 'error')).toMatchObject({ code: 'PENDING_SNAPSHOT_FAILED' });
    hub.publishEvent({ type: 'permission.request', source: 't', userId: 'alice', payload: { requestId: 'req-2' } });
    expect(events(alice.frames).map((e) => e.type)).toEqual(['permission.request']);
  });
});

describe('delivery', () => {
  test('two tabs of one user both receive the event; another user none', async () => {
    const hub = makeHub();
    const a1 = await tab(hub, 'alice');
    const a2 = await tab(hub, 'alice');
    const bob = await tab(hub, 'bob');
    hub.publishEvent({ type: 'chat.response', source: 't', userId: 'alice', sessionId: 's1', payload: { response: 'hi' } });
    expect(events(a1.frames)).toHaveLength(1);
    expect(events(a2.frames)).toHaveLength(1);
    expect(events(bob.frames)).toEqual([]);
  });

  test('`only` narrows to some of the user\'s tabs and never widens past the user', async () => {
    const hub = makeHub();
    const voice = await tab(hub, 'alice');
    const other = await tab(hub, 'alice');
    const bob = await tab(hub, 'bob');
    hub.connectionManager.getActiveConnections().find((c) => c.connectionId === voice.id)!.voiceSessionId = 's1';
    hub.connectionManager.getActiveConnections().find((c) => c.connectionId === bob.id)!.voiceSessionId = 's1';
    hub.publishEvent({ type: 'voice.speak', source: 't', userId: 'alice', sessionId: 's1', payload: { text: 'On it' } }, (ctx) => ctx.voiceSessionId === 's1');
    expect(events(voice.frames).map((e) => e.type)).toEqual(['voice.speak']);
    expect(events(other.frames)).toEqual([]);
    expect(events(bob.frames)).toEqual([]);
    // A spoken line is not kept for replay.
    expect(hub.eventBus.replaySince('s1').events).toEqual([]);
  });

  test('connections per user are capped; the one over the cap is told so', async () => {
    const cm = new ConnectionManager({ budget: { maxPerUser: () => 2 } });
    cm.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
    cm.setWorkspaceResolver(async () => 'ws-1');
    const results: Frame[] = [];
    for (let i = 0; i < 3; i++) {
      const frames: Frame[] = [];
      const id = cm.handleOpen({ data: {}, readyState: 1, send: (f: string) => frames.push(JSON.parse(f)), close: () => {} }, '127.0.0.1')!;
      await cm.handleMessage(id, JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: 'alice' }, clientType: 'webchat' }));
      results.push(frames.at(-1)!);
    }
    expect(results.map((f) => f.type)).toEqual(['auth_ok', 'auth_ok', 'auth_error']);
    expect(results[2]).toEqual({ type: 'auth_error', reason: 'Too many connections' });
    cm.drain();
  });
});

describe('replay buffers', () => {
  const event = (sessionId: string, id: string): UserGatewayEvent => ({
    id, type: 'chat.delta', source: 't', userId: 'alice', sessionId, timestamp: Date.now(), payload: {},
  });

  test('events after a known id; a gap when the id is gone', () => {
    const bus = new GatewayEventBus();
    for (const id of ['e1', 'e2', 'e3']) bus.publish(event('s1', id));
    expect(bus.replaySince('s1', 'e1')).toEqual({ events: [event('s1', 'e2'), event('s1', 'e3')].map((e) => expect.objectContaining({ id: e.id })), gap: false });
    expect(bus.replaySince('s1', 'gone').gap).toBe(true);
    expect(bus.replaySince('s1').events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  test('capped per process: the least recently active session is dropped first', () => {
    let cap = 2;
    const bus = new GatewayEventBus({ maxSessions: () => cap });
    bus.publish(event('s1', 'a'));
    bus.publish(event('s2', 'b'));
    bus.publish(event('s1', 'c')); // s1 is now the most recent
    bus.publish(event('s3', 'd'));
    expect(bus.replaySince('s2').events).toEqual([]);
    expect(bus.replaySince('s1').events.map((e) => e.id)).toEqual(['a', 'c']);
    expect(bus.getStats().replayBufferSessions).toBe(2);
    cap = 1; // a settings change applies to the next publish
    bus.publish(event('s3', 'e'));
    expect(bus.getStats().replayBufferSessions).toBe(1);
    expect(bus.replaySince('s1').events).toEqual([]);
  });

  test('a deleted or archived session\'s buffer is dropped', () => {
    const hub = makeHub();
    hub.publishEvent({ type: 'chat.delta', source: 't', userId: 'alice', sessionId: 'gone', payload: {} });
    hub.publishEvent({ type: 'swarm.node_spawned', source: 't', userId: 'alice', sessionId: 'gone', payload: {} });
    hub.publishEvent({ type: 'chat.delta', source: 't', userId: 'alice', sessionId: 'kept', payload: {} });
    sessionsRemoved(['gone']);
    expect(hub.eventBus.replaySince('gone').events).toEqual([]);
    expect(hub.eventBus.getReplayByPattern('swarm.*', 'gone')).toEqual([]);
    expect(hub.eventBus.replaySince('kept').events).toHaveLength(1);
  });
});
