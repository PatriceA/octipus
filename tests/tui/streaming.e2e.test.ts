/** A streaming reply is Markdown from the first block, and does not move when it completes. */
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const REPLY = '## Findings\n\nThe **parser** fails on:\n\n| Input | Result |\n|---|---|\n| `a,b` | ok |\n| `a,,b` | error |\n\n```js\nparse("a,,b");\n```\n\nFixed in one line.';

describe.skipIf(process.platform === 'win32')('streaming Markdown in a real terminal', () => {
  test('styled while streaming, block by block; the completed reply occupies the same rows', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 34);
    await tui.waitFor('connected');
    const cut = REPLY.indexOf('```js') + '```js\nparse('.length;
    tui.event('chat.delta', { delta: REPLY.slice(0, cut), iteration: 1 });
    await tui.waitFor('parse(');
    const mid = await tui.text();
    expect(mid).toContain('Findings');
    expect(mid).not.toContain('## Findings');
    expect(mid).not.toContain('**parser**');
    expect(mid).toMatch(/│ `?a,,b`?\s+│ error\s+│/);
    // The unterminated fence is a code block already, closed at the end of what arrived.
    expect(mid.split('\n').filter(row => row.trim() === '```')).toHaveLength(1);
    tui.event('chat.delta', { delta: REPLY.slice(cut), iteration: 1 });
    await tui.waitFor('Fixed in one line.');
    const streamed = (await tui.text()).split('\n');
    tui.event('chat.response', { response: REPLY });
    await new Promise(resolve => setTimeout(resolve, 200));
    const done = (await tui.text()).split('\n');
    const transcript = (rows: string[]) => rows.slice(0, rows.findIndex(row => row.includes('Fixed in one line.')) + 1);
    expect(transcript(done)).toEqual(transcript(streamed));
  });

  test('Alt+C copies the last code block of the reply, as written', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 34);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: REPLY });
    await tui.waitFor('Fixed in one line.');
    tui.send('\x1bc');
    await tui.waitFor('OSC 52');
    expect(tui.clipboardRequests.map(request => Buffer.from(request.split(';')[1] ?? '', 'base64').toString())).toEqual(['parse("a,,b");']);
  });
});
