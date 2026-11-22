/** OSC 8 links in replies and tool output where the terminal shows them; attached images drawn or described. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const REPLY = 'Read https://example.com/docs. The bug is in src/app.ts:12. Not [this](javascript:alert(1)) nor [that](ssh://host).';
const linkUrls = (raw: string) => [...raw.matchAll(/\x1b\]8;;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(m => m[1]);

describe.skipIf(process.platform === 'win32')('links and images in a real terminal', () => {
  test('a terminal that shows links gets URLs and path:line linked; other schemes are not', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24, [], { env: { TERM_PROGRAM: 'vscode' } });
    await tui.waitFor('connected');
    tui.event('chat.response', { response: REPLY });
    tui.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_use', id: 't', toolName: 'Bash', args: { command: 'npm test' } } });
    tui.event('agent.action', { agentId: 'root', data: { type: 'cli_tool_result', id: 't', toolName: 'Bash', output: 'FAIL tests/a.test.ts:30 see https://ci.example/run/7' } });
    await tui.waitFor('1 tool call');
    tui.send('\x0f'); // expand: the output is drawn
    await tui.waitFor('$ npm test');
    await tui.waitFor('FAIL tests/a.test.ts:30');
    const urls = linkUrls(tui.rawOutput());
    expect(urls).toContain('https://example.com/docs');
    expect(urls.some(url => url.startsWith('file://') && url.endsWith('/project/src/app.ts'))).toBe(true);
    expect(urls).toContain('https://ci.example/run/7');
    expect(urls.some(url => url.endsWith('/project/tests/a.test.ts'))).toBe(true);
    expect(urls.filter(url => !/^(https?|file):/.test(url))).toEqual([]);
    expect(await tui.text()).toContain('this');
  });

  test('a terminal not known to show links gets the text alone', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    tui.event('chat.response', { response: REPLY });
    await tui.waitFor('src/app.ts:12');
    expect(linkUrls(tui.rawOutput())).toEqual([]);
  });

  test('an attached image is described where the terminal cannot draw it', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24);
    await tui.waitFor('connected');
    writeFileSync(join(tui.project, 'pixel.png'), Buffer.from(PIXEL, 'base64'));
    tui.send('/attach pixel.png\r');
    await tui.waitFor('[image1] received: pixel.png');
    await tui.waitFor('[image/png]');
    expect(tui.rawOutput()).not.toContain('\x1b]1337;File=');
  });

  test.each([
    ['kitty graphics on the alternate screen', { TERM_PROGRAM: 'kitty' }, [], '\x1b_G'],
    // pi-tui draws iTerm2 images only in the main screen: the alternate screen cannot scroll them.
    ['iTerm2 images inline', { TERM_PROGRAM: 'iTerm.app' }, ['--inline'], '\x1b]1337;File='],
  ])('an attached image is drawn: %s', async (_label, env, args, sequence) => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 100, 24, args, { env });
    await tui.waitFor('connected');
    writeFileSync(join(tui.project, 'pixel.png'), Buffer.from(PIXEL, 'base64'));
    tui.send('/attach pixel.png\r');
    await tui.waitFor('[image1] received: pixel.png');
    const start = Date.now();
    while (!tui.rawOutput().includes(sequence) && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 50));
    expect(tui.rawOutput()).toContain(sequence);
  });
});
