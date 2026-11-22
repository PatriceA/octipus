/** The mouse in the real editor, through SGR reports (docs/plans/tui-modernization.md §7, Phase 5 item 1). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

// SGR coordinates are 1-based; screen rows and columns below are 0-based.
const press = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}M`;
const drag = (col: number, row: number) => `\x1b[<32;${col + 1};${row + 1}M`;
const release = (col: number, row: number) => `\x1b[<0;${col + 1};${row + 1}m`;
const click = (col: number, row: number) => press(col, row) + release(col, row);
const wheel = (col: number, row: number, down: boolean) => `\x1b[<${down ? 65 : 64};${col + 1};${row + 1}M`;
const decoded = (request: string | undefined) => Buffer.from((request ?? '').slice(2), 'base64').toString();

/** Screen row and column of the first `needle` on screen. */
async function find(h: TuiHarness, needle: string): Promise<{ row: number; col: number }> {
  const rows = (await h.text()).split('\n');
  const row = rows.findIndex((line) => line.includes(needle));
  if (row < 0) throw new Error(`no row shows ${needle}:\n${rows.join('\n')}`);
  return { row, col: rows[row].indexOf(needle) };
}

async function openExample(h: TuiHarness): Promise<void> {
  await h.waitFor('focus:editor'); await h.ready();
  h.send(KEY.CtrlO); await h.waitFor('Open file');
  h.send('example.ts'); h.send(KEY.Enter); await h.waitFor('const greeting');
}

describe.skipIf(process.platform === 'win32')('the mouse in the editor', () => {
  test('a click places the cursor; a drag selects and copies the file text without line numbers or tree; a double click takes a word', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    writeFileSync(join(tui.project, 'example.ts'), 'const greeting = "hello";\nlet second = 2;\nthird line\n');
    await openExample(tui);
    const g = await find(tui, 'greeting');
    tui.send(click(g.col, g.row)); await tui.waitFor('L1:7');
    tui.send('X'); await tui.waitFor('const Xgreeting');

    const second = await find(tui, 'second');
    tui.send(press(second.col, second.row)); tui.send(drag(second.col + 1, second.row + 1)); tui.send(release(second.col + 1, second.row + 1));
    await tui.waitFor('OSC 52');
    expect(decoded(tui.clipboardRequests.at(-1))).toBe('second = 2;\nthird');
    await tui.saveScreen('editor-mouse-selection');

    const hello = await find(tui, 'hello');
    const copies = tui.clipboardRequests.length;
    tui.send(click(hello.col + 1, hello.row)); tui.send(click(hello.col + 1, hello.row));
    for (let i = 0; i < 100 && tui.clipboardRequests.length === copies; i++) { await tui.text(); await new Promise((r) => setTimeout(r, 30)); }
    expect(decoded(tui.clipboardRequests.at(-1))).toBe('hello');
  });

  test('tabs, the tree, the wheel under the pointer and the divider take the mouse', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 28);
    writeFileSync(join(tui.project, 'long.txt'), Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n'));
    writeFileSync(join(tui.project, 'other.md'), '# other\n');
    await tui.waitFor('focus:editor'); await tui.ready();
    // A click on a tree row opens the file.
    const row = await find(tui, 'long.txt');
    tui.send(click(row.col, row.row)); await tui.waitFor('row 0');
    await tui.waitFor('focus:tree');
    const other = await find(tui, 'other.md');
    tui.send(click(other.col, other.row)); await tui.waitFor('# other');
    // The tabs: a click activates one, its × closes it.
    const tab = await find(tui, ' long.txt ×');
    tui.send(click(tab.col + 2, tab.row)); await tui.waitFor('row 0');
    // The wheel scrolls the editor under the pointer while the tree has the focus.
    const text = await find(tui, 'row 0');
    for (let i = 0; i < 5; i++) tui.send(wheel(text.col + 2, text.row + 3, true));
    await tui.waitFor('row 0 ', true);
    expect(await tui.text()).toContain('focus:tree');
    // Dragging the divider between the tree and the editor narrows the tree.
    const before = await find(tui, '│  Editor');
    tui.send(press(before.col, before.row + 2)); tui.send(drag(before.col - 10, before.row + 2)); tui.send(release(before.col - 10, before.row + 2));
    await new Promise((r) => setTimeout(r, 200));
    const after = (await tui.text()).split('\n')[before.row];
    expect(after.indexOf('│')).toBe(before.col - 10);
    // Close the other tab with its ×.
    const close = await find(tui, ' other.md ×');
    tui.send(click(close.col + ' other.md '.length, close.row));
    await tui.waitFor(' other.md ×', true);
  });
});
