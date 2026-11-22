/** Esc stops the running turn; messages typed during a turn wait, visibly, and go out when it ends. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, TUI } from '@/tui-kit';
import { OctipusTuiApp } from './app';
import { Composer } from './components/composer';
import type { AgentSessionEvent } from './gateway-adapter';
import { installOctipusKeybindings } from './keybindings';

const gateway = vi.hoisted(() => ({
  listener: (_event: AgentSessionEvent) => {},
  sendCommand: vi.fn(),
  sendChat: vi.fn(),
  stopAgent: vi.fn(),
}));
vi.mock('./gateway-adapter', () => ({ GatewayAdapter: class {
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand = gateway.sendCommand;
  sendChat = gateway.sendChat;
  stopAgent = gateway.stopAgent;
  getWorkspace() { return null; }
  disconnect() {}
} }));
vi.mock('@/core/gateway/cli-session', () => ({ readCliSession: () => null, clearCliSession: () => {} }));

const strip = (lines: readonly string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const ESC = '\x1b';

function mount() {
  let root!: Container;
  let input: (data: string) => unknown = () => undefined;
  const tui = {
    addChild: (child: Container) => { root = child; }, setFocus: vi.fn(), requestRender: vi.fn(), hasOverlay: () => false,
    addInputListener: (fn: (data: string) => unknown) => { input = fn; }, terminal: { rows: 30, columns: 100 },
  } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  const composer = root.children.find((c) => c instanceof Composer) as Composer;
  gateway.listener({ kind: 'status', status: 'connected' });
  return {
    app, composer,
    submit: (text: string) => composer.onSubmit?.(text),
    screen: () => strip(root.render(100)),
    key: (data: string) => input(data),
    chats: () => gateway.sendChat.mock.calls.map(call => call[1]),
  };
}

beforeEach(() => { gateway.sendCommand.mockClear(); gateway.sendChat.mockClear(); gateway.stopAgent.mockClear(); installOctipusKeybindings({}); });
afterEach(() => { vi.useRealTimers(); });

test('a message typed during a turn is queued above the composer and sent when the turn ends', async () => {
  const t = mount();
  t.submit('first');
  t.submit('second');
  t.submit('third');
  expect(t.chats()).toEqual(['first']);
  expect(t.screen()).toContain('⧗ queued 1 · second');
  expect(t.screen()).toContain('⧗ queued 2 · third');
  expect(t.screen()).toContain('sent when the turn ends');
  gateway.listener({ kind: 'message', role: 'assistant', content: 'Reply one' });
  // One at a time, as its own turn: the next waits for this one to end.
  expect(gateway.sendChat.mock.calls.at(-1)).toEqual([expect.any(String), 'second', undefined, undefined, 'queue']);
  expect(t.screen()).not.toContain('queued 2');
  expect(t.screen()).toContain('⧗ queued 1 · third');
  gateway.listener({ kind: 'error', message: 'model failed' });
  expect(t.chats()).toEqual(['first', 'second', 'third']);
  expect(t.screen()).not.toContain('⧗ queued');
  await t.app.stop();
});

test('a queued message can be taken back to edit or remove it before it is sent', async () => {
  const t = mount();
  t.submit('first');
  t.submit('typo mesage');
  t.key('\x1be'); // Alt+E
  expect(t.composer.getText()).toBe('typo mesage');
  expect(t.screen()).not.toContain('⧗ queued');
  gateway.listener({ kind: 'message', role: 'assistant', content: 'Reply' });
  // Nothing left in the queue: nothing goes out by itself.
  expect(t.chats()).toEqual(['first']);
  await t.app.stop();
});

test('Esc stops the running turn by its root agent; queued messages come back to the composer', async () => {
  const t = mount();
  t.submit('long task');
  gateway.listener({ kind: 'agent.start', role: 'general', model: 'm', nodeId: 'root-1', root: true });
  gateway.listener({ kind: 'agent.start', role: 'research', model: 'm', nodeId: 'child-1', subagent: true });
  t.submit('follow-up');
  expect(t.key(ESC)).toEqual({ consume: true });
  expect(gateway.stopAgent).toHaveBeenCalledWith('root-1');
  expect(t.screen()).toContain('Stopping the turn (Esc)');
  expect(t.composer.getText()).toBe('follow-up');
  gateway.listener({ kind: 'agent.stopped', agentId: 'root-1' });
  expect(t.chats()).toEqual(['long task']);
  // The agent is idle now: the second Esc clears the draft.
  t.key(ESC);
  expect(t.composer.getText()).toBe('');
  await t.app.stop();
});

test('Esc before the root agent is known sends the gateway abort; a second Esc while stopping does not send another', async () => {
  const t = mount();
  t.submit('quick');
  t.key(ESC);
  t.key(ESC);
  expect(gateway.sendCommand.mock.calls.filter(call => call[0] === 'abort')).toHaveLength(1);
  expect(gateway.stopAgent).not.toHaveBeenCalled();
  expect(t.screen()).toContain('Already stopping the turn');
  await t.app.stop();
});

test('with no turn running, one Esc warns and keeps the draft; a second within the window clears it', async () => {
  vi.useFakeTimers();
  const t = mount();
  t.composer.setText('keep me');
  t.key(ESC);
  expect(t.composer.getText()).toBe('keep me');
  expect(t.screen()).toContain('Esc again to clear the draft');
  vi.advanceTimersByTime(2000);
  expect(t.screen()).not.toContain('Esc again');
  t.key(ESC);
  expect(t.composer.getText()).toBe('keep me');
  t.key(ESC);
  expect(t.composer.getText()).toBe('');
  // An empty composer leaves Esc to whoever else wants it.
  expect(t.key(ESC)).toBeUndefined();
  await t.app.stop();
});

test('slash commands run during a turn instead of queueing', async () => {
  const t = mount();
  t.submit('working');
  t.submit('/status');
  expect(gateway.sendCommand).toHaveBeenCalledWith('status', undefined);
  expect(t.screen()).not.toContain('⧗ queued');
  await t.app.stop();
});

test('the turn a subagent finishing does not end; the root finishing does', async () => {
  const t = mount();
  t.submit('fan out');
  gateway.listener({ kind: 'agent.start', role: 'general', model: 'm', nodeId: 'root-1', root: true });
  gateway.listener({ kind: 'agent.start', role: 'research', model: 'm', nodeId: 'child-1', subagent: true });
  t.submit('later');
  gateway.listener({ kind: 'agent.end', stats: { tokens: 1, cost: 0 }, nodeId: 'child-1', role: 'research', root: false });
  expect(t.chats()).toEqual(['fan out']);
  gateway.listener({ kind: 'agent.end', stats: { tokens: 1, cost: 0 }, nodeId: 'root-1', role: 'general', root: true });
  expect(t.chats()).toEqual(['fan out', 'later']);
  await t.app.stop();
});
