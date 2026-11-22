/**
 * Visual regression for the main states of both surfaces (plan §7, Phase 6
 * item 3): each scene is driven through the real entry point in a PTY and its
 * frame — text and a per-cell style map — compared with `goldens/<scene>.txt`.
 *
 *   UPDATE_TUI_GOLDENS=1 npx vitest run tests/tui/golden.e2e.test.ts   # accept the new screens
 *   TUI_SCREENSHOTS_DIR=/tmp/shots npx vitest run tests/tui/golden.e2e.test.ts   # HTML pictures as well
 *
 * The scenes hold nothing that changes between runs or machines: the harness
 * home is a temporary directory whose name never reaches the frame (the
 * project shows as its base name, `project`), no clock or version is drawn,
 * spinner frames are folded to one glyph, and each capture waits for the frame
 * to stop changing.
 */
import { afterEach, describe, test } from 'vitest';
import { expectGolden, settledFrame } from './golden';
import { KEY, TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

/** Anything machine-specific that could still reach a row, replaced by a fixed token. */
function masker(h: TuiHarness): (row: string) => string {
  return row => row.replaceAll(h.home, '<home>').replace(/ · \d+(?:\.\d+)?(?:ms|s) — /, ' · <time> — ');
}
async function golden(h: TuiHarness, name: string): Promise<void> {
  const frame = await settledFrame(h, masker(h));
  await h.saveScreen(`golden-${name}`);
  expectGolden(name, frame);
}
const toolCall = (h: TuiHarness, toolName: string, args: Record<string, unknown>) =>
  h.event('agent.action', { agentId: 'root', data: { type: 'tool_call', toolName, args } });

describe.skipIf(process.platform === 'win32')('golden screens', () => {
  test('chat: idle, connected, with the plan', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.ready();
    await golden(tui, 'chat-idle');
  });

  test('chat: mid-turn, one tool done and one running', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.ready();
    tui.send('Run the build'); tui.send(KEY.Enter); await tui.waitFor('A streaming reply');
    toolCall(tui, 'shell', { command: 'npm run build' });
    await tui.waitFor('npm run build');
    tui.event('agent.action', { agentId: 'root', data: { type: 'tool_result', toolName: 'shell', output: 'built dist/index.js\nwarnings: 0' } });
    await tui.waitFor('built dist/index.js');
    toolCall(tui, 'read_file', { path: 'src/index.ts' });
    await tui.waitFor('src/index.ts');
    await golden(tui, 'chat-turn');
  });

  test('chat: the command palette over the transcript', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 28);
    await tui.ready();
    tui.send(KEY.CtrlP); await tui.waitFor('Commands ');
    tui.send('exp'); await tui.waitFor('filter: exp');
    await golden(tui, 'chat-palette');
  });

  test('editor: a file open beside the tree and the chat', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 100, 28);
    await tui.waitFor('focus:editor'); await tui.ready();
    tui.send(KEY.CtrlO); await tui.waitFor('Open file');
    tui.send('example.ts'); tui.send(KEY.Enter); await tui.waitFor('const greeting');
    await golden(tui, 'editor-file');
  });

  test('editor: reviewing an agent edit hunk by hunk', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 100, 28);
    await tui.waitFor('focus:editor'); await tui.ready();
    tui.send(KEY.CtrlO); await tui.waitFor('Open file');
    tui.send('example.ts'); tui.send(KEY.Enter); await tui.waitFor('const greeting');
    toolCall(tui, 'write_file', { path: 'example.ts', content: 'const greeting = "hi";\nconst farewell = "bye";\n' });
    // The edit waits in the mode bar until asked for: Alt+Y opens the review.
    await tui.waitFor('ready for review'); tui.send('\x1by');
    await tui.waitFor('hunk 1/');
    await golden(tui, 'editor-review');
  });
});
