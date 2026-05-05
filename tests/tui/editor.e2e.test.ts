/**
 * e2e: pi-tui editor surface (`bun run src/tui-editor/index.ts`).
 *
 * Covers the full keybinding-and-pane workflow that broke in early
 * Phase 5 builds:
 *   - launch + status line
 *   - file tree shows the project directory as the root entry
 *   - Ctrl+\\ cycles focus through editor → chat → tree
 *   - Ctrl+O opens the file picker; typing filters by basename;
 *     Enter opens the highlighted file (does NOT trigger the MCP
 *     overlay via the old Ctrl+M alias collision)
 *   - chat composer accepts input and submits
 *   - /quit terminates cleanly
 *
 * Like the chat suite, this only runs when the gateway is up.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { backendUp, KEY, TuiHarness } from './harness';

const backend = await backendUp();
const itIfBackend = (...args: Parameters<typeof it>) => (backend ? it(...args) : it.skip(...args));

describe('tui-editor', () => {
  let harness: TuiHarness | null = null;

  afterEach(async () => { await harness?.stop(); harness = null; });

  itIfBackend('renders status bar and tree root on launch', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('Octipus');
    await harness.waitFor('octipus');                  // tree root + status share the basename
    expect(harness.stripped()).toContain('focus:editor');
  }, 10_000);

  itIfBackend('cycles focus across panes on Ctrl+\\\\', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('focus:editor');
    harness.send(KEY.CtrlBackslash);
    await harness.waitFor('focus:chat');
    harness.send(KEY.CtrlBackslash);
    await harness.waitFor('focus:tree');
    harness.send(KEY.CtrlBackslash);
    await harness.waitFor('focus:editor');
  }, 10_000);

  itIfBackend('chat composer accepts input after focus switch', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('focus:editor');
    harness.send(KEY.CtrlBackslash);                   // focus chat
    await harness.waitFor('focus:chat');
    harness.send('hello editor');
    harness.send(KEY.Enter);
    await harness.waitFor('❯ hello editor');
    // Enter must NOT trigger the MCP overlay (regression: Ctrl+M ≡ \r).
    expect(harness.stripped()).not.toContain('No MCP servers');
  }, 10_000);

  itIfBackend('Ctrl+O opens file picker, filter narrows results, Enter opens file', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('focus:editor');
    harness.send(KEY.CtrlO);
    await harness.waitFor('Open file');
    harness.send('readme');
    await harness.wait(300);
    expect(harness.stripped()).toContain('filter: readme');
    expect(harness.stripped()).toContain('README.md');
    harness.send(KEY.Enter);
    // Wait for an actual line of README content to land in the editor pane —
    // matching only on the filename would race with the picker overlay text.
    await harness.waitFor('# Octipus');
    expect(harness.tail(40)).not.toContain('No buffer open');
  }, 10_000);

  itIfBackend('Ctrl+P opens the command palette', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('focus:editor');
    harness.send(KEY.CtrlP);
    await harness.waitFor('Command palette');
    expect(harness.stripped()).toContain('/help');
  }, 10_000);

  itIfBackend('/quit exits cleanly with status 0', async () => {
    harness = new TuiHarness({ entry: 'src/tui-editor/index.ts' });
    await harness.waitFor('focus:editor');
    harness.send(KEY.CtrlBackslash);
    await harness.waitFor('focus:chat');
    harness.send('/quit');
    harness.send(KEY.Enter);
    const exitCode = await new Promise<number | null>((resolve) => {
      harness!.proc.on('exit', (code) => resolve(code));
      setTimeout(() => resolve(null), 4000);
    });
    expect(exitCode).toBe(0);
  }, 10_000);
});
