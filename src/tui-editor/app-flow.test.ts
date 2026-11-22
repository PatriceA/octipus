import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Component, Container, TUI } from '@/tui-kit';
import { OctipusEditorApp } from './app';
import { DEFAULT_PERSISTED_STATE } from './persist';
import { installOctipusKeybindings } from '@/tui-pi/keybindings';
import type { AgentSessionEvent } from '@/tui-pi/gateway-adapter';
import type { checkDisk, DiskInfo, ReadResult, WriteResult } from './workspace-fs-bridge';

const f = vi.hoisted(() => ({
  listener: (_event: AgentSessionEvent) => {}, sendCommand: vi.fn(), getSessionId: (): string => '',
  respondApproval: vi.fn(), respondPermission: vi.fn(), savedState: vi.fn(), state: {} as any, listeners: 0,
  save: vi.fn((_path: string, _text: string): WriteResult => ({ ok: true, disk: DISK })),
  disk: vi.fn((): ReturnType<typeof checkDisk> => ({ changed: false, disk: DISK })),
  read: vi.fn((): ReadResult => ({ ok: true, text: 'on disk', disk: DISK, mixedEol: false })),
  parse: vi.fn(async (_key: string, _lang: string, _text: string) => {}), drop: vi.fn((_key: string) => {}),
  connect: vi.fn(async () => {}),
}));
const DISK = vi.hoisted((): DiskInfo => ({ mtimeMs: 1, size: 7, eol: '\n', bom: false, mode: 0o644 }));
vi.mock('@/tui-pi/gateway-adapter', () => ({ GatewayAdapter: class {
  constructor(options: { getSessionId: () => string }) { f.getSessionId = options.getSessionId; }
  on(listener: typeof f.listener) { f.listener = listener; return () => { f.listeners -= 1; }; }
  sendCommand = f.sendCommand; respondApproval = f.respondApproval; respondPermission = f.respondPermission;
  disconnect() {} sendChat() {} connect = f.connect;
} }));
vi.mock('./workspace-fs-bridge', () => ({ readFileForBuffer: f.read, writeFileForBuffer: f.save, checkDisk: f.disk }));
vi.mock('./persist', async original => ({ ...await original<typeof import('./persist')>(), loadPersistedState: () => f.state, savePersistedState: f.savedState }));
vi.mock('./editor/highlight-tree-sitter', () => ({ setSource: f.parse, dropSource: f.drop, installTreeSitterHighlighter() {}, hintLine() {} }));
vi.mock('@/mcp/bridge', () => ({ getMCPBridge: () => ({ getAllConnections: () => [] }) }));
let app: OctipusEditorApp;
let key: (data: string) => unknown;
let root: Container;
let modals: Component[];
let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
const text = () => root.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const modalKey = (data: string) => modals.at(-1)?.handleInput?.(data);
beforeEach(() => {
  vi.clearAllMocks(); f.save.mockReturnValue({ ok: true, disk: DISK }); f.savedState.mockReturnValue(true); f.state = DEFAULT_PERSISTED_STATE;
  f.disk.mockReturnValue({ changed: false, disk: DISK }); f.read.mockReturnValue({ ok: true, text: 'on disk', disk: DISK, mixedEol: false });
  installOctipusKeybindings({}); modals = []; exit = vi.fn<(code: number) => void>();
});
let tuiMock: { requestRender: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
function mount(options: { onShutdown?: () => Promise<void> } = {}) {
  const tui = { terminal: { rows: 28, columns: 120 }, addChild: (c: Container) => { root = c; },
    addInputListener: (listener: typeof key) => { key = listener; return () => { key = () => undefined; }; }, setFocus: vi.fn(), requestRender: vi.fn(), start: vi.fn(),
    hasOverlay: () => modals.length > 0,
    showOverlay: (component: Component) => { modals.push(component); return { focus() {}, hide() { modals = modals.filter(c => c !== component); } }; },
  } as unknown as TUI;
  tuiMock = tui as unknown as typeof tuiMock;
  return app = new OctipusEditorApp(tui, { exit, ...options });
}
/** Keys the TUI would route to the focused editor pane. */
const editorKey = (data: string) => (app as unknown as { editor: Component }).editor.handleInput?.(data);
/** Everything the chat transcript holds, unwrapped. */
const chatLog = () => (app as unknown as { chat: { messages: { entries(): Array<{ content: string }> } } }).chat.messages.entries().map((m) => m.content).join('\n');
const modalText = () => (modals.at(-1)?.render(100) ?? []).join('\n').replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '');
afterEach(async () => { await app?.stop(); });

test('editor chat forwards skill selection to the shared gateway', () => {
  const editor = mount();
  (editor as unknown as { handleChatSubmit(text: string): void }).handleChatSubmit('/skills Technical Writing session');
  expect(f.sendCommand).toHaveBeenCalledWith('skills', { value: 'Technical Writing session' });
});

/** An open file with an unsaved edit. */
function edited(app: OctipusEditorApp, path = '/tmp/test.ts', text = 'draft') {
  const rec = app.buffers.openFile(path, 'saved', { disk: DISK });
  rec.buffer.setText(text);
  return rec;
}

test('dirty close can cancel, save failure keeps edits, successful save closes', () => {
  const app = mount(); edited(app);
  key('\x17'); expect(text()).toContain('test.ts'); modalKey('\x1b'); expect(app.buffers.active()?.dirty).toBe(true);
  key('\x17'); f.save.mockReturnValue({ ok: false, error: 'Cannot save /tmp/test.ts: permission denied.' }); modalKey('s'); expect(app.buffers.active()?.dirty).toBe(true);
  expect(modals.at(-1)?.render(80).join('')).toContain('Save failed');
  f.save.mockReturnValue({ ok: true, disk: DISK }); modalKey('s'); expect(app.buffers.active()).toBeNull();
});

test('quit defaults to cancel and explicit discard removes recovery drafts', async () => {
  const app = mount(); edited(app);
  app.requestQuit(); modalKey('\r'); expect(exit).not.toHaveBeenCalled();
  app.requestQuit(); modalKey('d'); await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(f.savedState.mock.lastCall?.[0].drafts).toEqual([]);
});

test('shutdown checkpoints dirty drafts and restart restores them as unsaved', async () => {
  const first = mount(); edited(first, '/tmp/test.ts', 'recovered content');
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
  expect(modals).toHaveLength(0); expect(text()).toContain('agent edit to a.ts ready for review — press alt+y to resolve (+1 more)');
  key('\x1by'); expect(modals).toHaveLength(1); expect(modalText()).toContain('Agent edit: a.ts'); modalKey('r');
  expect(app.buffers.findByPath(a.path!)?.agentLocked).toBe(false); expect(modals).toHaveLength(0);
  key('\x1by'); expect(modalText()).toContain('Agent edit: b.ts');
  modalKey('r'); expect(app.buffers.findByPath(b.path!)?.agentLocked).toBe(false); expect(modals).toHaveLength(0);
  expect(text()).not.toContain('ready for review');
});

test('a wheel notch outside the chat pane is not passed to the editor or the tree', () => {
  mount();
  expect(key('\x1b[<64;10;5M')).toEqual({ consume: true });
  expect(key('\x1b[<65;10;5M')).toEqual({ consume: true });
  expect(key('a')).toBeUndefined();
});

test('Alt+M and /vim switch vim mode, shown in the mode bar; :w saves from NORMAL (docs/plans/tui-modernization.md §5.2)', () => {
  const app = mount(); edited(app);
  key('\x1bm');
  expect(app.layout.get().editorMode).toBe('vim');
  key('x'); // any key clears the "Vim mode on" notice
  expect(text()).toContain('VIM NORMAL');
  for (const c of ':w') editorKey(c);
  expect(text()).toContain(':w');
  editorKey('\r');
  expect(f.save).toHaveBeenCalledWith('/tmp/test.ts', 'draft', DISK);
  expect(app.buffers.active()?.dirty).toBe(false);
  (app as unknown as { handleChatSubmit(t: string): void }).handleChatSubmit('/vim off');
  expect(app.layout.get().editorMode).toBe('modeless');
});

test('vim :q on a dirty buffer asks first; :q! closes discarding', () => {
  const app = mount(); edited(app);
  app.layout.setEditorMode('vim');
  for (const c of ':q\r') editorKey(c);
  expect(modalText()).toContain('Unsaved changes');
  modalKey('\x1b');
  for (const c of ':q!\r') editorKey(c);
  expect(app.buffers.active()).toBeNull();
});

test('Ctrl+S on a scratch buffer opens Save As; the buffer then belongs to that file', () => {
  const app = mount();
  const scratch = app.buffers.openScratch();
  scratch.buffer.insert('notes');
  editorKey('\x13');
  expect(modalText()).toContain('Save Scratch 1 as');
  modalKey('\x1b[200~todo.md\x1b[201~'); modalKey('\r');
  expect(f.save).toHaveBeenCalledWith(`${process.cwd()}/todo.md`, 'notes', null);
  expect(modals).toHaveLength(0);
  const rec = app.buffers.active();
  expect(rec?.path).toBe(`${process.cwd()}/todo.md`);
  expect(rec?.label).toBe('todo.md');
  expect(rec?.dirty).toBe(false);
});

test('Save As refuses a missing folder and asks before replacing an existing file', () => {
  const app = mount(); edited(app);
  key('\x1b[24~'); // F12
  modalKey('\x15'); // clear the field
  modalKey('\x1b[200~no/such/folder/x.ts\x1b[201~'); modalKey('\r');
  expect(modalText()).toContain('does not exist');
  modalKey('\x15');
  modalKey('\x1b[200~package.json\x1b[201~'); modalKey('\r');
  expect(modalText()).toContain('already exists');
  expect(f.save).not.toHaveBeenCalled();
  modalKey('\r');
  expect(f.save).toHaveBeenCalledWith(`${process.cwd()}/package.json`, 'draft', null);
});

test('saving over a file that changed on disk asks: overwrite writes, reload takes the disk version, cancel leaves both', () => {
  const app = mount(); const rec = edited(app);
  f.disk.mockReturnValue({ changed: true, deleted: false });
  editorKey('\x13');
  expect(modalText()).toContain('changed on disk');
  expect(f.save).not.toHaveBeenCalled();
  modalKey('\x1b');
  expect(rec.buffer.text()).toBe('draft');
  editorKey('\x13'); modalKey('o');
  expect(f.save).toHaveBeenCalledWith('/tmp/test.ts', 'draft', DISK);
  rec.buffer.setText('mine');
  f.read.mockReturnValue({ ok: true, text: 'theirs', disk: { ...DISK, mtimeMs: 2 }, mixedEol: false });
  editorKey('\x13'); modalKey('r');
  expect(rec.buffer.text()).toBe('theirs');
  expect(app.buffers.active()?.dirty).toBe(false);
  rec.buffer.undo();
  expect(rec.buffer.text()).toBe('mine'); // the reload is one undo step
});

test('an agent write to a path relative to the project reaches its open buffer', () => {
  const app = mount();
  app.buffers.openFile(`${process.cwd()}/src/x.ts`, 'old', { disk: DISK });
  f.listener({ kind: 'agent.write', path: 'src/x.ts', newText: 'new' });
  key('\x1by');
  expect(modals).toHaveLength(1);
  expect(modalText()).toContain('Agent edit: x.ts');
});

test('rejecting an agent edit the agent already wrote leaves the buffer unsaved against the disk', () => {
  const app = mount(); app.buffers.openFile('/tmp/a.ts', 'mine', { disk: DISK });
  f.listener({ kind: 'agent.write', path: '/tmp/a.ts', newText: 'agent' });
  key('\x1by');
  f.disk.mockReturnValue({ changed: true, deleted: false });
  f.read.mockReturnValue({ ok: true, text: 'agent', disk: { ...DISK, mtimeMs: 2 }, mixedEol: false });
  modalKey('r');
  const rec = app.buffers.active();
  expect(rec?.buffer.text()).toBe('mine');
  expect(rec?.dirty).toBe(true);
  expect(text()).toContain('already wrote it to disk');
});

test('accepting an agent edit the agent already wrote leaves the buffer clean', () => {
  const app = mount(); app.buffers.openFile('/tmp/a.ts', 'mine', { disk: DISK });
  f.listener({ kind: 'agent.write', path: '/tmp/a.ts', newText: 'agent' });
  key('\x1by');
  f.disk.mockReturnValue({ changed: true, deleted: false });
  f.read.mockReturnValue({ ok: true, text: 'agent', disk: { ...DISK, mtimeMs: 2 }, mixedEol: false });
  modalKey('a');
  expect(app.buffers.active()?.buffer.text()).toBe('agent');
  expect(app.buffers.active()?.dirty).toBe(false);
});

test('pressing the workspace key twice while the list loads opens one picker, and a fetch failure is shown', async () => {
  let answer: (r: Response) => void = () => {};
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
  try {
    mount();
    key('\x0b'); key('\x0b');
    answer(new Response('down', { status: 503 }));
    await vi.waitFor(() => expect(modals).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(modals).toHaveLength(1);
    expect(modalText()).toContain('answered 503');
  } finally {
    vi.unstubAllGlobals();
  }
});

test('pressing the MCP key twice while the bridge loads opens one list', async () => {
  mount();
  key('\x05'); key('\x05');
  await vi.waitFor(() => expect(modals).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(modals).toHaveLength(1);
});

test('find draws its matches in the buffer and Esc returns the cursor', () => {
  const app = mount(); const rec = app.buffers.openFile('/tmp/a.ts', 'one two one', { disk: DISK });
  rec.buffer.setCursor({ line: 0, col: 2 });
  key('\x06'); // Ctrl+F
  modalKey('o'); modalKey('n'); modalKey('e');
  expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 8 });
  const raw = root.render(120).join('\n');
  expect(raw).toMatch(/\x1b\[4m/); // other matches underlined
  modalKey('\x1b');
  expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 2 });
  expect(root.render(120).join('\n')).not.toMatch(/\x1b\[4m/);
});

test('stop releases store subscriptions, the input listener and the adapter listener', async () => {
  f.listeners = 1;
  const app = mount();
  await app.stop();
  const renders = tuiMock.requestRender.mock.calls.length;
  app.buffers.openScratch().buffer.insert('after shutdown');
  app.layout.toggleTree();
  expect(tuiMock.requestRender.mock.calls.length).toBe(renders);
  expect(f.listeners).toBe(0);
  expect(key('\x0f')).toBeUndefined();
  expect(modals).toHaveLength(0);
});

test('start() that fails to connect restores the terminal before the error surfaces', async () => {
  const onShutdown = vi.fn(async () => {});
  const app = mount({ onShutdown });
  f.connect.mockRejectedValueOnce(new Error('corrupt session file'));
  await expect(app.start()).rejects.toThrow('corrupt session file');
  expect(onShutdown).toHaveBeenCalledTimes(1);
});

test('Ctrl+C copies the editor selection; with nothing selected it still asks to quit', () => {
  const app = mount(); const rec = edited(app, '/tmp/c.ts', 'copy me please');
  rec.buffer.select({ line: 0, col: 0 }, { line: 0, col: 7 });
  key('\x03');
  expect(modals).toHaveLength(0);
  expect((app as unknown as { lastCopy: string | null }).lastCopy).toBe('copy me');
  rec.buffer.setCursor({ line: 0, col: 0 });
  key('\x03');
  expect(modalText()).toContain('Unsaved changes');
});

test('Alt+Z and /wrap switch soft wrap, remembered in the checkpoint', async () => {
  const app = mount();
  key('\x1bz');
  expect(app.layout.get().softWrap).toBe(true);
  expect((app as unknown as { editor: { isWrapping(): boolean } }).editor.isWrapping()).toBe(true);
  (app as unknown as { handleChatSubmit(t: string): void }).handleChatSubmit('/wrap off');
  expect(app.layout.get().softWrap).toBe(false);
  key('\x1bz');
  await app.stop();
  expect(f.savedState.mock.lastCall?.[0].softWrap).toBe(true);
});

test('Ctrl+G goes to a line, or line:column; a line out of range is refused in the box', async () => {
  const { parseLineTarget } = await import('./components/input-prompt');
  expect(parseLineTarget('3:4', 5)).toEqual({ line: 2, col: 3 });
  expect(parseLineTarget('x', 5)).toEqual({ error: 'Type a line number, or line:column.' });
  const app = mount(); const rec = app.buffers.openFile('/tmp/g.ts', 'a\nb\nc\nd', { disk: DISK });
  key('\x07');
  expect(modalText()).toContain('Go to line in g.ts (1–4)');
  modalKey('9'); modalKey('\r');
  expect(modalText()).toContain('There are 4 lines');
  modalKey('\x7f'); modalKey('3'); modalKey(':'); modalKey('2'); modalKey('\r');
  expect(modals).toHaveLength(0);
  expect(rec.buffer.getCursor()).toEqual({ line: 2, col: 1 });
  (app as unknown as { handleChatSubmit(t: string): void }).handleChatSubmit('/goto 1');
  expect(rec.buffer.getCursor()).toEqual({ line: 0, col: 0 });
  expect(app.layout.get().focused).toBe('editor');
});

// docs/plans/tui-modernization.md §7, Phase 5 item 2: hunk-level review.
test('an agent edit to a file that is not open opens it in a review tab instead of being dropped', () => {
  const app = mount();
  const path = `${process.cwd()}/package.json`; // exists; its content comes from the mocked read
  f.read.mockReturnValue({ ok: true, text: 'one\ntwo\nthree', disk: DISK, mixedEol: false });
  f.listener({ kind: 'agent.write', path: 'package.json', newText: 'one\nTWO\nthree' });
  key('\x1by');
  expect(app.buffers.active()?.path).toBe(path);
  expect(app.buffers.active()?.agentLocked).toBe(true);
  expect(modalText()).toContain('Agent edit: package.json');
  expect(chatLog()).toContain('opened it for review');
  modalKey('a');
  expect(app.buffers.active()?.buffer.text()).toBe('one\nTWO\nthree');
  expect(app.buffers.active()?.agentLocked).toBe(false);
});

test('a partial accept puts the accepted hunks in the buffer as one undo step', () => {
  const app = mount();
  const rec = app.buffers.openFile('/tmp/a.ts', 'a\nb\nc\nd\ne', { disk: DISK });
  f.listener({ kind: 'agent.write', path: '/tmp/a.ts', newText: 'a\nB\nc\nD\ne' });
  key('\x1by');
  modalKey('y'); modalKey('n'); modalKey('\r');
  expect(rec.buffer.text()).toBe('a\nB\nc\nd\ne');
  expect(modals).toHaveLength(0);
  expect(chatLog()).toContain('Applied 1 of 2 hunks');
  rec.buffer.undo();
  expect(rec.buffer.text()).toBe('a\nb\nc\nd\ne');
});

test('an agent edit with CRLF line ends is compared without the CRs', () => {
  const app = mount();
  const rec = app.buffers.openFile('/tmp/w.txt', 'first\nsecond', { disk: { ...DISK, eol: '\r\n' } });
  f.listener({ kind: 'agent.write', path: '/tmp/w.txt', newText: 'first\r\nSECOND' });
  key('\x1by');
  expect(modalText()).not.toContain('- first');
  modalKey('a');
  expect(rec.buffer.text()).toBe('first\nSECOND');
});

test('a file changed on disk by something else during the review is not taken as the saved text', () => {
  const app = mount();
  const rec = app.buffers.openFile('/tmp/a.ts', 'mine', { disk: DISK });
  f.listener({ kind: 'agent.write', path: '/tmp/a.ts', newText: 'agent' });
  key('\x1by');
  f.disk.mockReturnValue({ changed: true, deleted: false });
  f.read.mockReturnValue({ ok: true, text: 'a third version', disk: { ...DISK, mtimeMs: 3 }, mixedEol: false });
  modalKey('a');
  expect(rec.buffer.text()).toBe('agent');
  expect(rec.savedText).toBe('mine'); // not the third version: saving will ask before overwriting it
  expect(chatLog()).toContain('also changed on disk outside this review');
  editorKey('\x13');
  expect(modalText()).toContain('changed on disk');
  expect(f.save).not.toHaveBeenCalled();
});

test('after Save As a.ts → b.ts, reopening a.ts gives its own tab: Ctrl+S there writes a.ts and closing it leaves b.ts open', () => {
  const app = mount();
  const files = (app as unknown as { files: import('./shell/file-ops').FileOps }).files;
  const a = `${process.cwd()}/a-original.ts`; const b = `${process.cwd()}/b-copy.ts`;
  app.buffers.openFile(a, 'on disk', { disk: DISK });
  expect(files.saveAs(app.buffers.active()!.id, 'b-copy.ts', 'b-copy.ts')).toBe('saved');
  files.openFile(a);
  const reopened = app.buffers.active()!;
  expect(reopened.path).toBe(a);
  reopened.buffer.setText('edited a');
  f.save.mockClear();
  editorKey('\x13');
  expect(f.save).toHaveBeenCalledWith(a, 'edited a', DISK);
  key('\x17');
  expect(app.buffers.get().buffers.map((r) => r.path)).toEqual([b]);
});

test('an agent edit while the user types in another tab waits: no prompt, no tab switch, keys go on to the editor; Ctrl+S on that buffer opens the review', () => {
  const app = mount();
  const target = app.buffers.openFile('/tmp/target.ts', 'old', { disk: DISK });
  const typing = app.buffers.openFile('/tmp/typing.ts', '', { disk: DISK });
  f.listener({ kind: 'agent.write', path: '/tmp/target.ts', newText: 'agent' });
  expect(modals).toHaveLength(0);
  expect(app.buffers.active()?.id).toBe(typing.id);
  for (const c of 'ar') editorKey(c); // a = accept all, r = reject all in the review box
  expect(typing.buffer.text()).toBe('ar');
  expect(target.buffer.text()).toBe('old');
  expect(text()).toContain('agent edit to target.ts ready for review');
  app.buffers.setActive(target.id);
  editorKey('\x13');
  expect(f.save).not.toHaveBeenCalled();
  expect(modalText()).toContain('Agent edit: target.ts');
  modalKey('a');
  expect(target.buffer.text()).toBe('agent');
});

test('an agent edit to a file that is not open opens it in a background tab, not the active one', () => {
  const app = mount();
  const typing = app.buffers.openFile('/tmp/typing.ts', '', { disk: DISK });
  f.read.mockReturnValue({ ok: true, text: 'one', disk: DISK, mixedEol: false });
  f.listener({ kind: 'agent.write', path: 'package.json', newText: 'two' });
  expect(app.buffers.active()?.id).toBe(typing.id);
  expect(app.buffers.findByPath(`${process.cwd()}/package.json`)).not.toBeNull();
  expect(modals).toHaveLength(0);
});
