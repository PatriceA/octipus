import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Container, TUI } from '@mariozechner/pi-tui';
import { OctipusTuiApp } from './app';
import { ActivityLine } from './components/activity-line';
import { Composer } from './components/composer';
import { MessagesPane } from './components/messages-pane';
import type { AgentSessionEvent } from './gateway-adapter';
import { installOctipusKeybindings } from './keybindings';

const gateway = vi.hoisted(() => ({
  listener: (_event: AgentSessionEvent) => {},
  sendCommand: vi.fn(),
  sendChat: vi.fn(),
  getSessionId: () => undefined as string | null | undefined,
}));
vi.mock('./gateway-adapter', () => ({ GatewayAdapter: class {
  constructor(options: { getSessionId: () => string }) { gateway.getSessionId = options.getSessionId; }
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand = gateway.sendCommand;
  sendChat = gateway.sendChat;
  getWorkspace() { return null; }
  disconnect() {}
} }));
vi.mock('@/core/gateway/cli-session', () => ({ readCliSession: () => null, clearCliSession: () => {} }));

const strip = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
type Input = (data: string) => unknown;

function mount(options: ConstructorParameters<typeof OctipusTuiApp>[1] = {}) {
  let root!: Container;
  let input: Input = () => undefined;
  const tui = {
    addChild: (child: Container) => { root = child; }, setFocus: vi.fn(), requestRender: vi.fn(),
    addInputListener: (fn: Input) => { input = fn; },
  } as unknown as TUI;
  const app = new OctipusTuiApp(tui, options);
  const find = <T>(ctor: new (...a: never[]) => T): T => root.children.find((c) => c instanceof ctor) as T;
  const pane = find(MessagesPane);
  return {
    app,
    submit: (text: string) => find(Composer).onSubmit?.(text),
    text: () => strip(pane.render(120)),
    activity: () => strip(find(ActivityLine).render(120)),
    key: (data: string) => input(data),
  };
}

beforeEach(() => { gateway.sendCommand.mockClear(); gateway.sendChat.mockClear(); installOctipusKeybindings({}); });
afterEach(() => { vi.useRealTimers(); });

test('unknown slash commands go to the gateway with their argument', async () => {
  const t = mount();
  t.submit('/persona be terse');
  expect(gateway.sendCommand).toHaveBeenCalledWith('persona', { value: 'be terse' });
  await t.app.stop();
});

test('/help appends the TUI-local commands the gateway cannot know about', async () => {
  const t = mount();
  gateway.listener({ kind: 'command.result', name: 'h', result: 'Available commands:\n  /help — List' });
  expect(t.text()).toContain('TUI commands:');
  expect(t.text()).toContain('/resume <n|id>');
  await t.app.stop();
});

test('/sessions then /resume <n> re-points the session and replays its transcript', async () => {
  const t = mount();
  const id = '11111111-2222-4333-8444-555555555555';
  gateway.listener({ kind: 'command.result', name: 'sessions', result: ' 1  aaaaaaaa …\n 2  11111111 …',
    data: [{ id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'first', updatedAt: '', messages: 1 }, { id, title: 'second', updatedAt: '', messages: 2 }] });
  expect(t.text()).toContain('/resume <n> reopens one');
  t.submit('/resume 2');
  expect(gateway.getSessionId()).toBe(id);
  expect(gateway.sendCommand).toHaveBeenLastCalledWith('history');
  gateway.listener({ kind: 'command.result', name: 'history', result: '…',
    data: [{ role: 'user', content: 'hello there', at: '2026-01-01T00:00:00Z' }, { role: 'assistant', content: 'hi back', at: '2026-01-01T00:00:01Z' }] });
  const text = t.text();
  expect(text).toContain('hello there');
  expect(text).toContain('hi back');
  expect(text).toContain('Session 11111111 · 2 messages replayed.');
  await t.app.stop();
});

test('a refused /resume rolls the session back so the next message does not go astray', async () => {
  const t = mount();
  const before = gateway.getSessionId();
  t.submit('/resume 11111111-2222-4333-8444-555555555555');
  expect(gateway.getSessionId()).toBe('11111111-2222-4333-8444-555555555555');
  gateway.listener({ kind: 'command.result', name: 'history', result: null, error: 'Session not found' });
  expect(gateway.getSessionId()).toBe(before);
  expect(t.text()).toContain('Could not open session 11111111: Session not found');
  t.submit('hello again');
  expect(gateway.sendChat).toHaveBeenCalledWith(before, 'hello again', undefined, undefined);
  await t.app.stop();
});

test('/resume with nothing to match explains itself instead of switching', async () => {
  const t = mount();
  const before = gateway.getSessionId();
  t.submit('/resume 7');
  expect(gateway.getSessionId()).toBe(before);
  expect(t.text()).toContain('run /sessions first');
  expect(gateway.sendCommand).not.toHaveBeenCalledWith('history');
  await t.app.stop();
});

test('--session replays the transcript once the gateway connects', async () => {
  const id = '99999999-2222-4333-8444-555555555555';
  const t = mount({ sessionId: id });
  expect(gateway.getSessionId()).toBe(id);
  gateway.listener({ kind: 'status', status: 'connected' });
  expect(gateway.sendCommand).toHaveBeenCalledWith('history');
  gateway.listener({ kind: 'status', status: 'connected' });
  expect(gateway.sendCommand.mock.calls.filter(([n]) => n === 'history')).toHaveLength(1);
  await t.app.stop();
});

test('Ctrl+Q quits and F5 prints the hotkeys', async () => {
  const exit = vi.fn();
  const t = mount({ exit });
  t.key('\x1b[15~'); // F5
  expect(t.text()).toContain('Command palette');
  t.key('\x11'); // Ctrl+Q
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
});

test('the thinking line shows model and elapsed seconds', async () => {
  vi.useFakeTimers();
  const t = mount();
  gateway.listener({ kind: 'agent.start', role: 'general', model: 'ornith:35b' });
  vi.advanceTimersByTime(5000);
  gateway.listener({ kind: 'agent.iteration', agentId: 'root', iteration: 2 });
  expect(t.activity()).toMatch(/thinking · general · iter 2 · 5s · ornith:35b/);
  gateway.listener({ kind: 'agent.end', stats: { tokens: 1, cost: 0 } });
  expect(t.activity()).toBe('');
  await t.app.stop();
});

test('streamed deltas draw live, an iteration change keeps the earlier text, the reply supersedes the live block', async () => {
  const t = mount();
  gateway.listener({ kind: 'delta', delta: 'Let me ', iteration: 1 });
  gateway.listener({ kind: 'delta', delta: 'check.', iteration: 1 });
  expect(t.text()).toContain('Let me check.');
  gateway.listener({ kind: 'delta', delta: 'The answer', iteration: 2 });
  expect(t.text()).toContain('Let me check.');
  expect(t.text()).toContain('The answer');
  gateway.listener({ kind: 'message', role: 'assistant', content: 'The answer is 42.' });
  const text = t.text();
  expect(text).toContain('The answer is 42.');
  expect(text.match(/The answer/g)).toHaveLength(1);
  gateway.listener({ kind: 'delta', delta: 'x', iteration: 3 });
  gateway.listener({ kind: 'agent.end', stats: { tokens: 1, cost: 0 } });
  expect(t.text()).not.toMatch(/\n\s+x$/);
  await t.app.stop();
});

test('partial text from a failed turn is dropped, not promoted into history by the next turn', async () => {
  const t = mount();
  gateway.listener({ kind: 'delta', delta: 'half an ans', iteration: 1 });
  gateway.listener({ kind: 'error', message: 'provider died' });
  expect(t.text()).not.toContain('half an ans');
  gateway.listener({ kind: 'agent.start', role: 'general', model: 'm' });
  gateway.listener({ kind: 'delta', delta: 'fresh', iteration: 1 });
  expect(t.text()).not.toContain('half an ans');
  expect(t.text()).toContain('fresh');
  await t.app.stop();
});
