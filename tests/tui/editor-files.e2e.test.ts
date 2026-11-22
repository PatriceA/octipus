/** New file, rename, delete and the watch for external changes in the real editor (docs/plans/tui-modernization.md §7, Phase 5 item 5). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

async function openExample(h: TuiHarness): Promise<void> {
  await h.waitFor('focus:editor');
  h.send(KEY.CtrlO); await h.waitFor('Open file');
  h.send('example.ts'); h.send(KEY.Enter); await h.waitFor('const greeting');
}

describe.skipIf(process.platform === 'win32')('file operations in a real POSIX terminal', () => {
  test('Alt+N creates a file, /rename moves it with its unsaved edits, /delete asks and removes it', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await tui.waitFor('focus:editor');
    tui.send('\x1bn'); await tui.waitFor('New file');
    tui.send('fresh.md'); tui.send(KEY.Enter);
    await tui.waitFor(' fresh.md ×');
    expect(readFileSync(join(tui.project, 'fresh.md'), 'utf8')).toBe('');
    await tui.waitFor('fresh.md', false);
    tui.send('draft text'); await tui.waitFor('draft text');

    tui.send(KEY.CtrlBackslash); await tui.waitFor('focus:chat');
    tui.send('/rename notes/renamed.md\r'); await tui.waitFor('The folder notes does not');
    tui.send('/rename renamed.md\r'); await tui.waitFor(' ● renamed.md ×');
    expect(existsSync(join(tui.project, 'fresh.md'))).toBe(false);
    expect(existsSync(join(tui.project, 'renamed.md'))).toBe(true);
    await tui.saveScreen('editor-rename');

    tui.send('/delete\r'); await tui.waitFor('Delete renamed.md?');
    expect(await tui.text()).toContain('its unsaved');
    tui.send(KEY.Esc); await tui.waitFor('Delete renamed.md?', true);
    expect(existsSync(join(tui.project, 'renamed.md'))).toBe(true);
    tui.send('/delete\r'); await tui.waitFor('Delete renamed.md?');
    tui.send('y'); await tui.waitFor('Deleted renamed.md');
    expect(existsSync(join(tui.project, 'renamed.md'))).toBe(false);
    await tui.waitFor(' renamed.md ×', true);
  });

  test('a file changed on disk while open is reloaded when clean, and waits for Alt+Y when it has unsaved edits', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    await openExample(tui);
    const path = join(tui.project, 'example.ts');
    writeFileSync(path, 'const changedOutside = 1;\n');
    await tui.waitFor('const changedOutside');
    await tui.waitFor('changed on disk and was reloaded');

    tui.send('MINE '); await tui.waitFor('MINE const changedOutside');
    writeFileSync(path, 'const changedAgain = 2;\n');
    // No prompt over the typing: the mode bar says so, and the next keys still go to the editor.
    await tui.waitFor('example.ts changed on disk — press alt+y to resolve');
    expect(await tui.text()).not.toContain('File changed on disk');
    tui.send('or'); await tui.waitFor('MINE orconst changedOutside');
    tui.send('\x7f\x7f'); await tui.waitFor('MINE const changedOutside');
    tui.send('\x1by'); await tui.waitFor('File changed on disk');
    tui.send('r'); await tui.waitFor('const changedAgain');
    await tui.waitFor('MINE', true);
    tui.send('\x1a'); await tui.waitFor('MINE const changedOutside'); // the reload is one undo step
    expect(readFileSync(path, 'utf8')).toBe('const changedAgain = 2;\n');
  });
});
