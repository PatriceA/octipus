/** Reviewing the agent's edits hunk by hunk in the real editor (docs/plans/tui-modernization.md §7, Phase 5 item 2). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';
let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const agentWrites = (h: TuiHarness, path: string, content: string) =>
  h.event('agent.action', { agentId: 'root', data: { type: 'tool_call', toolName: 'write_file', args: { path, content } } });

describe.skipIf(process.platform === 'win32')('agent edit review in a real POSIX terminal', () => {
  test('an edit to a file that is not open opens a review tab; a partial accept of a CRLF file saves CRLF with the chosen hunks', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 30);
    const path = join(tui.project, 'review.txt');
    const original = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'];
    writeFileSync(path, `${original.join('\r\n')}\r\n`);
    await tui.waitFor('focus:editor'); await tui.waitFor('connected');
    // Three hunks: the first line, a middle one, and an addition at the end.
    const proposed = ['ALPHA', 'bravo', 'charlie', 'DELTA', 'echo', 'foxtrot', 'golf', 'hotel', ''];
    agentWrites(tui, 'review.txt', proposed.join('\r\n'));
    await tui.waitFor('Agent edit: review.txt');
    await tui.waitFor('hunk 1/3');
    expect(await tui.text()).toContain(' review.txt ');
    tui.send('y'); await tui.waitFor('hunk 2/3');
    tui.send('n'); await tui.waitFor('hunk 3/3');
    tui.send('y'); await tui.waitFor('2 accepted, 1 rejected');
    await tui.saveScreen('editor-review');
    tui.send('\r'); await tui.waitFor('Agent edit: review.txt', true);
    await tui.waitFor('ALPHA');
    expect(await tui.text()).toContain('delta');
    // The agent did not write the file in this harness: the review result is unsaved until Ctrl+S.
    tui.send('\x13'); await tui.waitFor('Saved review.txt');
    expect(readFileSync(path, 'utf8')).toBe(['ALPHA', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', ''].join('\r\n'));
  });

  test('rejecting every hunk leaves the buffer and the file as they were', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 30);
    const path = join(tui.project, 'keep.ts');
    writeFileSync(path, 'export const a = 1;\nexport const b = 2;\n');
    await tui.waitFor('focus:editor'); await tui.waitFor('connected');
    agentWrites(tui, path, 'export const a = 100;\nexport const b = 2;\n');
    await tui.waitFor('Agent edit: keep.ts');
    tui.send('\x1b'); await tui.waitFor('Agent edit: keep.ts', true);
    await tui.waitFor('export const a = 1;');
    await tui.waitFor('Rejected agent edit');
    expect(readFileSync(path, 'utf8')).toBe('export const a = 1;\nexport const b = 2;\n');
  });
});
