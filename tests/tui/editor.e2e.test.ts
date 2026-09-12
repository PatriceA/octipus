import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness, KEY } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

describe.skipIf(process.platform === 'win32')('editor in a real POSIX terminal', () => {
  test('opens, edits, protects unsaved close, saves, and renders the focused pane after resize', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file');
    tui.send('example.ts'); tui.send(KEY.Enter); await tui.waitFor('const greeting');
    await tui.saveScreen('editor');
    tui.send('X'); await tui.waitFor('Xconst');
    tui.send(KEY.CtrlW); await tui.waitFor('Unsaved changes');
    tui.send(KEY.Esc); await tui.waitFor('Unsaved changes', true); await tui.waitFor('Xconst');
    tui.send('\x13'); await tui.waitFor('Saved');
    expect(readFileSync(join(tui.project, 'example.ts'), 'utf8')).toMatch(/^Xconst/);
    tui.resize(50, 16); await tui.waitFor('switch pane');
    tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat');
    expect(await tui.text()).toContain('Chat');
    tui.send('hello from editor\r'); await tui.waitFor('A streaming reply');
    await tui.saveScreen('editor-narrow');
    tui.event('agent.approval_required', { requestId: 'edit-q', question: 'Keep this change?', options: ['Keep', 'Revise'] });
    await tui.waitFor('Keep this change?'); tui.send('2'); await tui.waitFor('Keep this change?', true);
    expect(tui.commands).toContainEqual(expect.objectContaining({ type: 'approval.respond', requestId: 'edit-q', response: 'Revise' }));
  });

  test('dirty quit defaults to cancel and only exits after explicit discard', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts'); await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file'); tui.send('example.ts\r'); await tui.waitFor('const greeting');
    tui.send('UNSAVED'); tui.send(KEY.CtrlQ); await tui.waitFor('Unsaved changes');
    tui.send(KEY.Enter); await tui.waitFor('Unsaved changes', true);
    expect(tui.proc.exitCode).toBeNull();
    tui.send(KEY.CtrlQ); await tui.waitFor('Unsaved changes'); tui.send('d');
    expect(await tui.exited).toBe(0);
    expect(readFileSync(join(tui.project, 'example.ts'), 'utf8')).not.toContain('UNSAVED');
  });
});
