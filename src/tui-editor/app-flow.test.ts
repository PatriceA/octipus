import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Component, Container, TUI } from '@mariozechner/pi-tui';
import { OctipusEditorApp } from './app';
import { DEFAULT_PERSISTED_STATE } from './persist';
import { installOctipusKeybindings } from '@/tui-pi/keybindings';
import type { AgentSessionEvent } from '@/tui-pi/gateway-adapter';

const f = vi.hoisted(() => ({
  listener: (_event: AgentSessionEvent) => {}, sendCommand: vi.fn(), getSessionId: (): string => '',
  respondApproval: vi.fn(), respondPermission: vi.fn(), save: vi.fn(() => true), savedState: vi.fn(), state: {} as any,
}));
vi.mock('@/tui-pi/gateway-adapter', () => ({ GatewayAdapter: class {
  constructor(options: { getSessionId: () => string }) { f.getSessionId = options.getSessionId; }
  on(listener: typeof f.listener) { f.listener = listener; }
  sendCommand = f.sendCommand; respondApproval = f.respondApproval; respondPermission = f.respondPermission;
  disconnect() {} sendChat() {}
} }));
vi.mock('./workspace-fs-bridge', () => ({ readFileForBuffer: () => 'on disk', writeFileForBuffer: f.save }));
vi.mock('./persist', async original => ({ ...await original<typeof import('./persist')>(), loadPersistedState: () => f.state, savePersistedState: f.savedState }));
vi.mock('./editor/highlight-tree-sitter', () => ({ setSource: () => {}, installTreeSitterHighlighter() {}, hintLineIndex() {} }));
vi.mock('@/mcp/bridge', () => ({ getMCPBridge: () => ({ getAllConnections: () => [] }) }));
let app: OctipusEditorApp;
let key: (data: string) => unknown;
let root: Container;
let modals: Component[];
let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
const text = () => root.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const modalKey = (data: string) => modals.at(-1)?.handleInput?.(data);
beforeEach(() => {
  vi.clearAllMocks(); f.save.mockReturnValue(true); f.savedState.mockReturnValue(true); f.state = DEFAULT_PERSISTED_STATE;
  installOctipusKeybindings({}); modals = []; exit = vi.fn<(code: number) => void>();
});
function mount() {
  const tui = { terminal: { rows: 28, columns: 120 }, addChild: (c: Container) => { root = c; },
    addInputListener: (listener: typeof key) => { key = listener; }, setFocus: vi.fn(), requestRender: vi.fn(),
    hasOverlay: () => modals.length > 0,
    showOverlay: (component: Component) => { modals.push(component); return { focus() {}, hide() { modals = modals.filter(c => c !== component); } }; },
  } as unknown as TUI;
  return app = new OctipusEditorApp(tui, { exit });
}
afterEach(async () => { await app?.stop(); });

test('dirty close can cancel, save failure keeps edits, successful save closes', () => {
  const app = mount(); const rec = app.buffers.openFile('/tmp/test.ts', 'draft'); app.buffers.markDirty(rec.id, true);
  key('\x17'); expect(text()).toContain('test.ts'); modalKey('\x1b'); expect(app.buffers.active()?.dirty).toBe(true);
  key('\x17'); f.save.mockReturnValue(false); modalKey('s'); expect(app.buffers.active()?.dirty).toBe(true);
  expect(modals.at(-1)?.render(80).join('')).toContain('Save failed');
  f.save.mockReturnValue(true); modalKey('s'); expect(app.buffers.active()).toBeNull();
});

test('quit defaults to cancel and explicit discard removes recovery drafts', async () => {
  const app = mount(); const rec = app.buffers.openFile('/tmp/test.ts', 'draft'); app.buffers.markDirty(rec.id, true);
  app.requestQuit(); modalKey('\r'); expect(exit).not.toHaveBeenCalled();
  app.requestQuit(); modalKey('d'); await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(f.savedState.mock.lastCall?.[0].drafts).toEqual([]);
});

test('shutdown checkpoints dirty drafts and restart restores them as unsaved', async () => {
  const first = mount(); const rec = first.buffers.openFile('/tmp/test.ts', 'recovered content'); first.buffers.markDirty(rec.id, true);
  await first.stop(); f.state = f.savedState.mock.lastCall?.[0];
  const second = mount(); expect(second.buffers.active()?.buffer.text()).toBe('recovered content'); expect(second.buffers.active()?.dirty).toBe(true);
});

test('editor uses the shared streaming, plan, identity, usage and approval presentation', () => {
  mount(); expect(f.getSessionId()).toMatch(/^[0-9a-f-]{36}$/);
  f.listener({ kind: 'status', status: 'connected' }); expect(f.sendCommand).toHaveBeenCalledWith('work-plan-status');
  f.listener({ kind: 'delta', delta: 'Streaming now', iteration: 1 }); expect(text()).toContain('Streaming now');
  f.listener({ kind: 'message', role: 'assistant', content: 'Final answer' }); expect(text()).not.toContain('Streaming now');
  f.listener({ kind: 'identity', user: 'patrice' });
  f.listener({ kind: 'session.stats', stats: { tokens: 42000, cost: 0.5, requests: 2, contextTokens: 1000, contextWindow: 10000 } });
  f.listener({ kind: 'command.result', name: 'work-plan-status', result: '1/3 steps done' });
  expect(text()).toContain('@patrice'); expect(text()).toContain('42.0k tok'); expect(text()).toContain('1/3 steps done');
  f.listener({ kind: 'approval', requestId: 'a', summary: '', question: 'Choose?', options: ['One', 'Two'] });
  key('\x10'); expect(modals).toHaveLength(1); // palette cannot dismiss a pending decision
  modalKey('2'); expect(f.respondApproval).toHaveBeenCalledWith('a', true, 'Two');
});

test('multiple file diffs are reviewed in sequence without orphaning locks', () => {
  const app = mount(); const a = app.buffers.openFile('/tmp/a.ts', 'a'); const b = app.buffers.openFile('/tmp/b.ts', 'b');
  f.listener({ kind: 'agent.write', path: '/tmp/a.ts', newText: 'new a' });
  f.listener({ kind: 'agent.write', path: '/tmp/b.ts', newText: 'new b' });
  expect(modals).toHaveLength(1); modalKey('r');
  expect(app.buffers.findByPath(a.path!)?.agentLocked).toBe(false); expect(modals).toHaveLength(1);
  modalKey('r'); expect(app.buffers.findByPath(b.path!)?.agentLocked).toBe(false); expect(modals).toHaveLength(0);
});
