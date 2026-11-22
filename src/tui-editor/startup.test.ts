/**
 * Nothing slow runs before the editor's first frame (plan §7, Phase 6 item 4).
 * The MCP status poll imported `@/mcp/bridge` from the constructor: some 200
 * server modules, about a second on the main thread, and the first frame
 * waited for it. The bridge is now loaded by the MCP list alone, and the
 * status row follows it from then on.
 */
import { afterEach, expect, test, vi } from 'vitest';
import type { Container, TUI } from '@/tui-kit';
import { installOctipusKeybindings } from '@/tui-pi/keybindings';
import { OctipusEditorApp } from './app';
import { DEFAULT_PERSISTED_STATE } from './persist';

const bridge = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/mcp/bridge', () => ({ getMCPBridge: () => {
  bridge.calls += 1;
  return { getAllConnections: () => [{ id: 'docs', server: { name: 'docs', type: 'stdio' }, status: 'connected', tools: [] }] };
} }));
vi.mock('@/tui-pi/gateway-adapter', () => ({ GatewayAdapter: class {
  on() { return () => {}; }
  sendCommand() {} disconnect() {} sendChat() {}
  async connect() {}
} }));
vi.mock('./persist', async original => ({ ...await original<typeof import('./persist')>(), loadPersistedState: () => DEFAULT_PERSISTED_STATE, savePersistedState: () => true }));
vi.mock('./editor/highlight-tree-sitter', () => ({ setSource: async () => {}, dropSource() {}, installTreeSitterHighlighter() {}, hintLine() {} }));

let app: OctipusEditorApp | undefined;
afterEach(async () => { await app?.stop(); app = undefined; });

const nextTurn = () => new Promise<void>(done => setImmediate(done));

test('the MCP bridge is not loaded to draw the editor; once the MCP list loads it, the status row shows its connections', async () => {
  installOctipusKeybindings({});
  let root: Container | undefined;
  const tui = {
    terminal: { rows: 28, columns: 120 }, addChild: (c: Container) => { root = c; },
    addInputListener: () => () => {}, setFocus() {}, requestRender() {}, start() {}, hasOverlay: () => false,
    showOverlay: () => ({ focus() {}, hide() {} }),
  } as unknown as TUI;
  app = new OctipusEditorApp(tui, { exit: () => {}, projectPath: process.cwd() });
  await app.start();
  if (!root) throw new Error('the editor mounted nothing');
  for (let i = 0; i < 5; i++) { root.render(120); await nextTurn(); }
  expect(bridge.calls).toBe(0);
  expect(root.render(120).join('\n')).not.toContain('mcp:');

  await (app as unknown as { overlays: { openMCPServerList(): Promise<void> } }).overlays.openMCPServerList();
  expect(bridge.calls).toBeGreaterThan(0);
  expect(root.render(120).join('\n')).toContain('mcp:1/1');
});
