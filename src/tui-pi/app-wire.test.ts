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
import { errorFrame, FakeSocket, wire } from './testing/wire';

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
    sid: () => String(FakeSocket.all.flatMap(s => s.sent).find(frame => typeof frame.sessionId === 'string')?.sessionId),
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

test('errors that are not this turn failing do not end it: permission, approval, rate limit, dropped events', async () => {
  const t = await mount();
  t.submit('long job');
  const sid = t.sid();
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.socket.event(wire.delta(sid, 'root-1', 'Still streaming here'));
  t.submit('queued behind it');
  t.socket.receive(errorFrame('PERMISSION_ERROR', 'That permission request is no longer pending (already answered, or expired).'));
  t.socket.receive(errorFrame('APPROVAL_EXPIRED', 'The approval expired'));
  t.socket.receive(errorFrame('RATE_LIMITED', 'Rate limited. Retry after 3s'));
  t.socket.receive({ type: 'events_dropped', count: 4, reason: 'slow consumer' });
  expect(t.chats()).toEqual(['long job']);
  expect(t.screen()).toContain('⧗ queued 1 · queued behind it');
  expect(t.screen()).toContain('Still streaming here');
  expect(t.screen()).toContain('Rate limited');
  // The turn's own failure does end it.
  t.socket.receive(errorFrame('CHAT_ERROR', 'model failed', { sessionId: sid, turnId: t.lastTurnId() }));
  expect(t.chats()).toEqual(['long job', 'queued behind it']);
  await t.app.stop();
});

test('a refused chat.send (rate limited before the handler) ends that turn: the server echoes its turnId', async () => {
  const t = await mount();
  t.submit('too fast');
  t.submit('next');
  t.socket.receive(errorFrame('RATE_LIMITED', 'Rate limited. Retry after 3s', { sessionId: t.sid(), turnId: t.lastTurnId() }));
  expect(t.chats()).toEqual(['too fast', 'next']);
  await t.app.stop();
});

test('the late failure of a stopped turn neither ends the next turn nor wipes its live reply', async () => {
  const t = await mount();
  t.submit('first');
  const sid = t.sid();
  const first = t.lastTurnId();
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.key(ESC);
  t.socket.event(wire.agentStopped(sid, 'root-1', true));
  t.submit('second');
  expect(t.chats()).toEqual(['first', 'second']);
  t.socket.event(wire.rootSpawned(sid, 'root-2'));
  t.socket.event(wire.delta(sid, 'root-2', 'Second reply streaming'));
  t.submit('third');
  // What the server sends for the stopped send, late.
  t.socket.receive(errorFrame('CHAT_CANCELLED', 'Task was stopped', { sessionId: sid, turnId: first }));
  t.socket.event(wire.chatError(sid, 'Task was stopped', { cancelled: true, turnId: first }));
  t.socket.event(wire.chatResponse(sid, 'Stopped.', first));
  expect(t.chats()).toEqual(['first', 'second']);
  expect(t.screen()).toContain('Second reply streaming');
  expect(t.screen()).toContain('⧗ queued 1 · third');
  t.socket.event(wire.chatResponse(sid, 'Second answer.', t.lastTurnId()));
  expect(t.chats()).toEqual(['first', 'second', 'third']);
  await t.app.stop();
});

test('another tab stopping its own turn, or a background reply, does not end this one', async () => {
  const t = await mount();
  t.submit('mine');
  const sid = t.sid();
  t.submit('after mine');
  // Another session's root, stopped from another tab: the adapter drops it by session.
  t.socket.event(wire.agentStopped('99999999-0000-4000-8000-000000000000', 'root-x', true));
  // A server without the session on the envelope: no id match, no end.
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.socket.event(wire.agentStopped(undefined, 'root-x', true));
  // A scheduled wake-up answering in this session, with no turn id.
  t.socket.event(wire.backgroundResponse(sid, 'Your reminder.'));
  expect(t.chats()).toEqual(['mine']);
  expect(t.screen()).toContain('Your reminder.');
  t.socket.event(wire.chatResponse(sid, 'Mine answered.', t.lastTurnId()));
  expect(t.chats()).toEqual(['mine', 'after mine']);
  await t.app.stop();
});

test('a turn another tab started ends on its chat.error, which is shown here', async () => {
  const t = await mount();
  t.socket.event(wire.rootSpawned(t.sid(), 'root-7'));
  t.submit('wait for it');
  t.socket.event(wire.chatError(t.sid(), 'provider down'));
  expect(t.screen()).toContain('The turn failed: provider down');
  expect(t.chats()).toEqual(['wait for it']);
  await t.app.stop();
});

/** Where each needle first appears in the transcript, in order; -1 when missing. */
const order = (screen: string, ...needles: string[]) => needles.map(needle => screen.indexOf(needle));

test('the next queued message goes below the reply it waited for, in the transcript and the export', async () => {
  const t = await mount();
  t.submit('first question');
  const sid = t.sid();
  t.socket.event(wire.rootSpawned(sid, 'root-1'));
  t.socket.event(wire.delta(sid, 'root-1', 'Streaming the first'));
  t.submit('second question');
  // The real order: the root's worker_completed, then the reply, then the stats.
  t.socket.event(wire.rootCompleted(sid, 'root-1'));
  expect(t.chats()).toEqual(['first question']);
  t.socket.event(wire.chatResponse(sid, 'First answer.', t.lastTurnId()));
  t.socket.event(wire.sessionStats(sid));
  expect(t.chats()).toEqual(['first question', 'second question']);
  const [question, answer, next] = order(t.screen(), 'first question', 'First answer.', 'second question');
  expect(question).toBeGreaterThan(-1);
  expect(answer).toBeGreaterThan(question);
  expect(next).toBeGreaterThan(answer);
  // The same order in what /export writes.
  const { transcriptMarkdown } = await import('./transcript-export');
  const entries = (t.app as unknown as { messages: { entries(): Parameters<typeof transcriptMarkdown>[0] } }).messages.entries();
  const markdown = transcriptMarkdown(entries, sid, new Date());
  const [q, a, n] = order(markdown, 'first question', 'First answer.', 'second question');
  expect(a).toBeGreaterThan(q);
  expect(n).toBeGreaterThan(a);
  await t.app.stop();
});

test('a failed turn shows its error before the next queued message', async () => {
  const t = await mount();
  t.submit('will fail');
  const sid = t.sid();
  t.submit('after the failure');
  t.socket.receive(errorFrame('CHAT_ERROR', 'model failed', { sessionId: sid, turnId: t.lastTurnId() }));
  const [failure, next] = order(t.screen(), 'model failed', 'after the failure');
  expect(failure).toBeGreaterThan(-1);
  expect(next).toBeGreaterThan(failure);
  await t.app.stop();
});
