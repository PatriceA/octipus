/**
 * The chat's turn logic against real gateway traffic: frames in the shapes
 * the server emits (`./testing/wire`), through the real `GatewayClient` and
 * `GatewayAdapter` decode path — no mocked adapter, no hand-made `nodeId`s.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, TUI } from '@/tui-kit';
import { OctipusTuiApp } from './app';
import { Composer } from './components/composer';
import { installOctipusKeybindings } from './keybindings';
import { FakeSocket, wire } from './testing/wire';

vi.mock('@/core/gateway/cli-session', () => ({
  readCliSession: () => ({ token: 'test-token', userId: 'user-1', username: 'tester', isAdmin: false }),
  clearCliSession: () => {},
}));

const strip = (lines: readonly string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
const ESC = '\x1b';

async function mount() {
  let root!: Container;
  let input: (data: string) => unknown = () => undefined;
  const tui = {
    addChild: (child: Container) => { root = child; }, setFocus: vi.fn(), requestRender: vi.fn(), hasOverlay: () => false,
    addInputListener: (fn: (data: string) => unknown) => { input = fn; }, terminal: { rows: 40, columns: 100 },
  } as unknown as TUI;
  const app = new OctipusTuiApp(tui, { gatewayUrl: 'ws://gateway.test/gateway' });
  await app.adapter.connect();
  const socket = FakeSocket.latest();
  socket.open();
  const composer = root.children.find((c) => c instanceof Composer) as Composer;
  const sent = (type: string) => FakeSocket.all.flatMap(s => s.sent).filter(frame => frame.type === type);
  const chats = () => sent('chat.send');
  return {
    app, composer, socket,
    submit: (text: string) => composer.onSubmit?.(text),
    screen: () => strip(root.render(100)),
    key: (data: string) => input(data),
    sent,
    chats: () => chats().map(frame => frame.content),
    /** The session the chat sends under (the adapter drops events of any other). */
    sid: () => String(chats()[0]?.sessionId),
    lastTurnId: () => chats().at(-1)?.turnId as string | undefined,
  };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  installOctipusKeybindings({});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('a worker finishing does not end the turn while the root still runs, nor wipe the root\'s live reply', async () => {
  const t = await mount();
  t.submit('fan out');
  const sid = t.sid();
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.socket.event(wire.delta(sid, 'root-1', 'Working on it, the root streams'));
  t.socket.event(wire.workerSpawned(sid, 'worker-1', 'root-1'));
  t.submit('later');
  t.socket.event(wire.workerCompleted(sid, 'worker-1'));
  expect(t.chats()).toEqual(['fan out']);
  expect(t.screen()).toContain('⧗ queued 1 · later');
  expect(t.screen()).toContain('Working on it, the root streams');
  t.socket.event(wire.rootCompleted(sid, 'root-1'));
  t.socket.event(wire.chatResponse(sid, 'All done.', t.lastTurnId()));
  expect(t.chats()).toEqual(['fan out', 'later']);
  await t.app.stop();
});

test('a worker spawning never takes the root\'s place as what Esc stops', async () => {
  const t = await mount();
  t.submit('fan out');
  const sid = t.sid();
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.socket.event(wire.workerSpawned(sid, 'worker-1', 'root-1'));
  t.key(ESC);
  expect(t.sent('agent.stop')).toEqual([{ type: 'agent.stop', agentId: 'root-1' }]);
  await t.app.stop();
});

test('Esc before the root is known stops this session only (never the user-wide /abort), and stops the root once it starts', async () => {
  const t = await mount();
  t.submit('quick');
  const sid = t.sid();
  t.key(ESC);
  expect(t.sent('command').filter(frame => frame.name === 'abort')).toEqual([]);
  expect(t.sent('session.stop')).toEqual([{ type: 'session.stop', sessionId: sid }]);
  // The message had not reached the session's queue yet: nothing stopped.
  t.socket.event(wire.sessionStopped(sid, 0, 0));
  expect(t.screen()).toContain('stopped as soon as it starts');
  t.socket.event(wire.rootSpawned(sid, 'root-9'));
  expect(t.sent('agent.stop')).toEqual([{ type: 'agent.stop', agentId: 'root-9' }]);
  t.socket.event(wire.agentStopped(undefined, 'root-9', true));
  t.key(ESC);
  // The turn is over: Esc no longer stops anything.
  expect(t.sent('agent.stop')).toHaveLength(1);
  expect(t.sent('session.stop')).toHaveLength(1);
  await t.app.stop();
});

test('a session stop that stopped something ends the turn', async () => {
  const t = await mount();
  t.submit('quick');
  t.submit('next one');
  const sid = t.sid();
  t.key(ESC);
  t.socket.event(wire.sessionStopped(sid, 2, 0));
  // The queued message came back to the composer; nothing more was sent.
  expect(t.chats()).toEqual(['quick']);
  expect(t.composer.getText()).toBe('next one');
  // The turn is over: the next message goes out at once instead of queueing.
  t.submit('again');
  expect(t.chats()).toEqual(['quick', 'again']);
  await t.app.stop();
});
