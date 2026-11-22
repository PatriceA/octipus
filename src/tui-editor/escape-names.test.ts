/**
 * A file name is text from outside: it can hold ESC, OSC and BEL bytes
 * (`printf 'x\e]0;owned\a.ts'` is a valid name). Every place the editor
 * draws a path or a file name must draw it as text, never write those
 * bytes to the terminal — a title change, a screen clear or a bell from a
 * file name.
 *
 * Real files in a temporary project; the gateway, the checkpoint and the
 * highlighter are stand-ins.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { Component, Container, TUI } from '@/tui-kit';
import type { AgentSessionEvent } from '@/tui-pi/gateway-adapter';
import { installOctipusKeybindings } from '@/tui-pi/keybindings';
import { OctipusEditorApp } from './app';
import { DEFAULT_PERSISTED_STATE } from './persist';
import type { FileCommands } from './shell/file-commands';
import type { FileOps } from './shell/file-ops';

const f = vi.hoisted(() => ({ listener: (_event: AgentSessionEvent) => {} }));
vi.mock('@/tui-pi/gateway-adapter', () => ({ GatewayAdapter: class {
  on(listener: typeof f.listener) { f.listener = listener; return () => {}; }
  sendCommand() {} respondApproval() {} respondPermission() {} disconnect() {} sendChat() {} async connect() {}
} }));
vi.mock('./persist', async original => ({ ...await original<typeof import('./persist')>(), loadPersistedState: () => DEFAULT_PERSISTED_STATE, savePersistedState: () => true }));
vi.mock('./editor/highlight-tree-sitter', () => ({ setSource: async () => {}, dropSource() {}, installTreeSitterHighlighter() {}, hintLine() {}, onHighlighterProblem: () => () => {} }));
vi.mock('@/mcp/bridge', () => ({ getMCPBridge: () => ({ getAllConnections: () => [] }) }));

/** A title change (OSC 0), a screen clear (CSI 2J), a bell, and a lone ESC. */
const EVIL = 'ev\x1b]0;owned\x07il\x1b[2J\x07\x1b.ts';
let project: string;
let path: string;
let app: OctipusEditorApp;
let key: (data: string) => unknown;
let root: Container;
let modals: Component[];

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'escape-names-'));
  path = join(project, EVIL);
});
afterAll(() => { rmSync(project, { recursive: true, force: true }); });
beforeEach(() => {
  writeFileSync(path, 'const needle = 1;\n');
  installOctipusKeybindings({});
  modals = [];
  const tui = { terminal: { rows: 30, columns: 160 }, addChild: (c: Container) => { root = c; },
    addInputListener: (listener: typeof key) => { key = listener; return () => {}; }, setFocus: vi.fn(), requestRender: vi.fn(), start: vi.fn(),
    hasOverlay: () => modals.length > 0,
    showOverlay: (component: Component) => { modals.push(component); return { focus() {}, hide() { modals = modals.filter(c => c !== component); } }; },
  } as unknown as TUI;
  app = new OctipusEditorApp(tui, { exit: vi.fn(), projectPath: project });
});
afterEach(async () => { await app.stop(); });

const shell = () => app as unknown as { files: FileOps; fileCommands: FileCommands; editor: Component; handleChatSubmit(text: string): void };
const open = () => { shell().files.openFile(path); return app.buffers.active()!; };

/** What reached the screen: the panes, the mode bar and the open boxes. */
function screen(): string {
  return [...root.render(160), ...modals.flatMap((m) => m.render(120))].join('\n');
}

/** The bytes left once the app's own styling (SGR) and cursor markers (APC) are taken out: none may be a control. */
function stray(output: string): string[] {
  const rest = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_pi:[^\x07]*\x07/g, '');
  return [...rest.matchAll(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g)].map((m) => JSON.stringify(rest.slice(Math.max(0, m.index - 10), m.index + 10)));
}

test.each<[string, () => Promise<void> | void]>([
  ['the tab strip, the tree and the mode bar', () => { open(); }],
  ['the unsaved-changes prompt', () => { open().buffer.insert('x'); key('\x17'); }],
  ['the rename prompt, prefilled with the path', () => { open(); shell().fileCommands.rename(''); }],
  ['the Save As prompt, prefilled with the path', () => { open(); key('\x1b[24~'); }],
  ['the delete confirmation', () => { open(); shell().fileCommands.delete(); }],
  ['the changed-on-disk prompt', () => { const rec = open(); shell().files.promptExternalChange(rec.id, false); }],
  ['the agent review and its waiting notice', () => {
    open(); app.buffers.openScratch();
    f.listener({ kind: 'agent.write', path, newText: 'const needle = 2;\n' });
    expect(stray(screen())).toEqual([]);
    key('\x1by');
  }],
  ['a save notice and the transcript', () => { const rec = open(); rec.buffer.insert('x'); shell().files.saveBuffer(rec.id); }],
  ['a refused rename, in the prompt', () => { open(); shell().fileCommands.rename(''); modals.at(-1)?.handleInput?.('\r'); writeFileSync(join(project, 'taken.ts'), ''); shell().fileCommands.rename(EVIL); }],
  ['the file picker', () => { key('\x0f'); modals.at(-1)?.handleInput?.('ev'); }],
  ['project search results', async () => {
    shell().handleChatSubmit('/search needle');
    await vi.waitFor(() => expect(screen()).toContain('1 match in 1 file'), { timeout: 5000 });
  }],
])('%s draws a file name with ESC, OSC and BEL bytes as text', async (_where, act) => {
  await act();
  const output = screen();
  // The name is there as text: without its escape sequences, or with its controls as pictures (␛ ␇).
  expect(output.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/ev(?:␛\]0;owned␇)?il/);
  expect(stray(output)).toEqual([]);
});

test('a tab with such a name is as wide as it is drawn: its × is where a click closes it', () => {
  open();
  app.buffers.openScratch();
  const tabs = (app as unknown as { tabs: Component & { handleMouse(e: object): unknown } }).tabs;
  const line = tabs.render(160)[0].replace(/\x1b\[[0-9;]*m/g, '');
  const x = line.indexOf('×');
  tabs.handleMouse({ type: 'click', button: 'left', x, y: 0, screenX: x, screenY: 0, width: 160, height: 1, shift: false, alt: false, ctrl: false, clickCount: 1 });
  expect(app.buffers.findByPath(path)).toBeNull();
});
