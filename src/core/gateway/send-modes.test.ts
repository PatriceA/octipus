/**
 * Explicit send modes on `chat.send` / `chat.steer`
 * (docs/plans/orchestration-gaps-2026-11.md §3): every send is answered with
 * `chat.delivery` naming what happened, and `agent.stop` on a root drops the
 * turns queued behind it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GatewayHub } from './hub';
import type { ClientMessage, ConnectionContext } from './protocol';

const mock = vi.hoisted(() => ({
  handle: vi.fn(async (..._args: unknown[]) => ({ response: 'ok' })),
  workers: [] as unknown[],
  stopSession: vi.fn(() => 1),
  stop: vi.fn(() => true),
  get: vi.fn((_id: string): unknown => undefined),
  create: vi.fn(async () => undefined),
}));
const sid = 'bbbbbbbb-0000-4000-8000-000000000000';
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: mock.handle }) }));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({ getBySession: () => mock.workers, stopSession: mock.stopSession, stop: mock.stop, get: mock.get }),
}));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async () => ({ id: 'bbbbbbbb-0000-4000-8000-000000000000', userId: 'user' }), incrementMessageCount: async () => undefined },
}));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: { create: mock.create } }));
vi.mock('@/core/agent/session-resolver', () => ({ resolveSession: async () => 'bbbbbbbb-0000-4000-8000-000000000000', turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/core/companion/user-control', () => ({ recordCompanionOwnerStop: async () => undefined }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ getSessionStats: async () => ({}) }) }));

import { withSessionTurn } from '@/core/session-turn-lock';
import { wireMessageHandler } from './message-handler';

type Handler = (id: string, context: ConnectionContext, message: ClientMessage) => Promise<void>;

function wire() {
  let handler!: Handler;
  const send = vi.fn();
  const publish = vi.fn();
  wireMessageHandler({
    setMessageHandler: (fn: Handler) => { handler = fn; },
    setPendingSnapshotProvider: vi.fn(),
    setConnectionClosedHandler: vi.fn(),
    publishEvent: publish,
    connectionManager: { sendToConnection: send },
  } as unknown as GatewayHub);
  const context = { userId: 'user', trustLevel: 'user', clientType: 'webchat', metadata: {} } as unknown as ConnectionContext;
  const deliveries = () => send.mock.calls.map(([, frame]) => frame).filter((frame: { type: string }) => frame.type === 'chat.delivery');
  return { run: (message: ClientMessage) => handler('connection', context, message), send, publish, deliveries };
}

function rootWorker(opts: { acceptsMidTurn?: boolean } = {}) {
  const steer = vi.fn(() => true);
  return {
    steer,
    worker: {
      getContext: () => ({ id: 'root-1', root: true, userId: 'user', sessionId: sid, metadata: {} }),
      getStatus: () => 'running',
      steer,
      canAcceptSteering: () => true,
      ...(opts.acceptsMidTurn === undefined ? {} : { acceptsMidTurnSteering: () => opts.acceptsMidTurn }),
    },
  };
}

/** Hold the session's turn lock as a running turn would, until released. */
function holdTurn(): () => Promise<void> {
  let release!: () => void;
  const held = withSessionTurn(sid, () => new Promise<void>(resolve => { release = resolve; }));
  return async () => { release(); await held; };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.workers = [];
  mock.handle.mockImplementation(async () => ({ response: 'ok' }));
  mock.stop.mockImplementation(() => true);
});
afterEach(() => { mock.workers = []; });

describe('chat.send modes', () => {
  test('auto steers a running root that takes guidance mid-turn', async () => {
    const { steer, worker } = rootWorker();
    mock.workers = [worker];
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'focus on auth' });
    expect(steer).toHaveBeenCalledOnce();
    expect(mock.handle).not.toHaveBeenCalled();
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'auto', outcome: 'steered' }]);
    expect(gw.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.message', payload: { role: 'user', content: 'focus on auth', injected: true } }));
  });

  test('auto queues for a buffered CLI root instead of reporting an injection', async () => {
    const { steer, worker } = rootWorker({ acceptsMidTurn: false });
    mock.workers = [worker];
    const release = holdTurn();
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'also check labels' });
    await release();
    expect(steer).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.handle).toHaveBeenCalledOnce();
    expect(gw.deliveries()).toEqual([{
      type: 'chat.delivery', sessionId: sid, mode: 'auto', outcome: 'queued', ahead: 1, reason: 'The running agent cannot take input mid-turn.',
    }]);
    expect(gw.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.message' }));
  });

  test('queue never steers, and counts the turns ahead', async () => {
    const { steer, worker } = rootWorker();
    mock.workers = [worker];
    const release = holdTurn();
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'next task', mode: 'queue' });
    await release();
    expect(steer).not.toHaveBeenCalled();
    expect(mock.handle).toHaveBeenCalledOnce();
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'queue', outcome: 'queued', ahead: 1 }]);
  });

  test('steer refuses when nothing running takes it, and stores nothing', async () => {
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'change course', mode: 'steer' });
    expect(mock.handle).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'steer', outcome: 'refused', reason: 'No turn is running in this session.' }]);

    const { steer, worker } = rootWorker({ acceptsMidTurn: false });
    mock.workers = [worker];
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'change course', mode: 'steer' });
    expect(steer).not.toHaveBeenCalled();
    expect(gw.deliveries().at(-1)).toMatchObject({ outcome: 'refused', reason: 'The running agent cannot take input mid-turn.' });

    await gw.run({ type: 'chat.send', sessionId: sid, content: 'see this', mode: 'steer', fileRefs: [{ path: 'a.txt' }] });
    expect(gw.deliveries().at(-1)).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('files') });
    expect(mock.handle).not.toHaveBeenCalled();
  });

  test('restart takes the front place before it stops the turn, so a turn queued earlier cannot run first', async () => {
    const { steer, worker } = rootWorker();
    mock.workers = [worker];
    const order: string[] = [];
    // The running turn holds the lock; turn B is already queued behind it.
    let releaseRunning!: () => void;
    const running = withSessionTurn(sid, () => new Promise<void>(resolve => { releaseRunning = resolve; }), { owner: 'user' });
    const queuedB = withSessionTurn(sid, async () => { order.push('B'); }, { owner: 'user' });
    // Stopping the root ends the running turn at once (before the handler
    // reaches handleMessage), and handleMessage awaits before its lock call.
    mock.stop.mockImplementation(() => { releaseRunning(); return true; });
    mock.handle.mockImplementation(async (...args: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const internal = args[10] as { queueReservation?: import('@/core/session-turn-lock').SessionTurnReservation } | undefined;
      await withSessionTurn(sid, async () => { order.push('R'); }, internal?.queueReservation ? { reservation: internal.queueReservation } : {});
      return { response: 'ok' };
    });
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'start over with X', mode: 'restart' });
    await Promise.all([running, queuedB]);
    expect(steer).not.toHaveBeenCalled();
    expect(mock.stop).toHaveBeenCalledWith('root-1', { actorUserId: 'user' });
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'restart', outcome: 'restarted' }]);
    expect(order).toEqual(['R', 'B']);
  });

  test('restart never stops or jumps another member\'s running turn', async () => {
    const { worker } = rootWorker();
    mock.workers = [{ ...worker, getContext: () => ({ id: 'root-2', root: true, userId: 'bob', sessionId: sid, metadata: {} }) }];
    const release = holdTurn();
    const gw = wire();
    const sent = gw.run({ type: 'chat.send', sessionId: sid, content: 'start over', mode: 'restart' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await release();
    await sent;
    expect(mock.stop).not.toHaveBeenCalled();
    expect(gw.deliveries()).toEqual([{
      type: 'chat.delivery', sessionId: sid, mode: 'restart', outcome: 'queued', ahead: 1, reason: 'The running turn is another member\'s; this message waits its turn.',
    }]);
    expect(mock.handle.mock.calls[0][10]).toBeUndefined();
  });

  test('restart with nothing running is a normal turn, and says so', async () => {
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'start over', mode: 'restart' });
    expect(mock.stop).not.toHaveBeenCalled();
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'restart', outcome: 'queued', ahead: 0, reason: 'No turn was running to restart.' }]);
    // The handler never consumed the reservation (mocked): the lock is free again.
    const { isSessionTurnRunning } = await import('@/core/session-turn-lock');
    (mock.handle.mock.calls[0][10] as { queueReservation: { release(): void } }).queueReservation.release();
    expect(isSessionTurnRunning(sid)).toBe(false);
  });

  test('a queued send dropped by /stop ends with CHAT_CANCELLED and a cancelled chat.error', async () => {
    const { SessionTurnCancelledError } = await import('@/core/session-turn-lock');
    mock.handle.mockImplementation(async () => { throw new SessionTurnCancelledError(sid); });
    const gw = wire();
    await gw.run({ type: 'chat.send', sessionId: sid, content: 'later', mode: 'queue' });
    expect(gw.send).toHaveBeenCalledWith('connection', expect.objectContaining({ type: 'error', code: 'CHAT_CANCELLED' }));
    expect(gw.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.error', payload: expect.objectContaining({ cancelled: true }) }));
  });
});

describe('chat.steer modes', () => {
  test('auto falls back to a normal turn; steer refuses', async () => {
    const gw = wire();
    await gw.run({ type: 'chat.steer', sessionId: sid, content: 'go left' });
    expect(mock.handle).toHaveBeenCalledOnce();
    expect(gw.deliveries()).toEqual([{ type: 'chat.delivery', sessionId: sid, mode: 'auto', outcome: 'queued', ahead: 0 }]);
    await gw.run({ type: 'chat.steer', sessionId: sid, content: 'go left', mode: 'steer' });
    expect(mock.handle).toHaveBeenCalledOnce();
    expect(gw.deliveries().at(-1)).toMatchObject({ mode: 'steer', outcome: 'refused' });
  });
});

describe('agent.stop', () => {
  test('stopping the running root drops the caller\'s turns queued behind it, not other members\'', async () => {
    const { worker } = rootWorker();
    mock.get.mockReturnValue(worker);
    const release = holdTurn();
    const mine = withSessionTurn(sid, async () => 'ran', { owner: 'user' }).catch((err: Error) => err.name);
    const theirs = withSessionTurn(sid, async () => 'ran', { owner: 'bob' });
    await Promise.resolve();
    const gw = wire();
    await gw.run({ type: 'agent.stop', agentId: 'root-1' });
    expect(await mine).toBe('SessionTurnCancelledError');
    expect(mock.stop).toHaveBeenCalledWith('root-1', { actorUserId: 'user' });
    expect(gw.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent.stopped', payload: { agentId: 'root-1', stoppedBy: 'user', droppedQueued: 1 },
    }));
    await release();
    expect(await theirs).toBe('ran');
  });

  test('a finished root, or a child, leaves the queue alone', async () => {
    const release = holdTurn();
    const queued = withSessionTurn(sid, async () => 'ran', { owner: 'user' });
    const gw = wire();
    mock.get.mockReturnValue({ getContext: () => ({ id: 'child-1', root: false, userId: 'user', sessionId: sid }), getStatus: () => 'running' });
    await gw.run({ type: 'agent.stop', agentId: 'child-1' });
    expect(gw.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.stopped', payload: { agentId: 'child-1', stoppedBy: 'user' } }));
    mock.get.mockReturnValue({ getContext: () => ({ id: 'old-root', root: true, userId: 'user', sessionId: sid }), getStatus: () => 'completed' });
    await gw.run({ type: 'agent.stop', agentId: 'old-root' });
    expect(gw.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.stopped', payload: { agentId: 'old-root', stoppedBy: 'user' } }));
    await release();
    expect(await queued).toBe('ran');
  });
});
