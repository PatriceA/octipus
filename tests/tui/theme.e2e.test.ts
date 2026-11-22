/** Themes in a real terminal: the background picks dark or light, /theme switches and saves, NO_COLOR is honoured. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TuiHarness } from './harness';

let tui: TuiHarness | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; });

/** Every foreground colour on screen, as 0xrrggbb, and whether any cell had one. */
function colours(h: TuiHarness): Set<number> {
  const found = new Set<number>();
  const buffer = h.screen.buffer.active;
  for (let row = 0; row < h.screen.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    for (let col = 0; col < h.screen.cols; col++) {
      const cell = line?.getCell(col);
      if (cell?.isFgRGB() && cell.getChars().trim()) found.add(cell.getFgColor());
    }
  }
  return found;
}

const waitUntil = async (check: () => boolean | Promise<boolean>, what: string) => {
  const start = Date.now();
  while (Date.now() - start < 8000) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(process.platform === 'win32')('themes in a real terminal', () => {
  test('a light terminal background (OSC 11) switches to the light palette', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    const h = tui;
    await h.waitFor('connected');
    await waitUntil(() => h.rawOutput().includes('\x1b]11;?'), 'the background query');
    expect(colours(h).has(0xa6babd)).toBe(true); // dark's dim, before the answer
    h.send('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
    h.send('\x1b[?62;22c');
    await waitUntil(async () => { await h.text(); return colours(h).has(0x636c76); }, "light's dim colour");
    expect(colours(h).has(0xa6babd)).toBe(false);
  });

  test('/theme switches at once and saves it in tui.json', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24);
    const h = tui;
    await h.waitFor('connected');
    h.send('/theme high-contrast\r');
    await h.waitFor('Theme: high-contrast');
    await waitUntil(async () => { await h.text(); return colours(h).has(0xd0d0d0); }, 'the high-contrast dim colour');
    expect(JSON.parse(readFileSync(join(h.home, '.octipus', 'tui.json'), 'utf8'))).toEqual({ theme: 'high-contrast' });
    h.send('/theme sepia\r');
    await h.waitFor('unknown theme "sepia"');
  });

  test('a saved theme applies from the first frame, without asking the terminal', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, [], { files: { '.octipus/tui.json': '{ "theme": "light" }' } });
    await tui.waitFor('connected');
    expect(colours(tui).has(0x636c76)).toBe(true);
    expect(tui.rawOutput()).not.toContain('\x1b]11;?');
  });

  test('NO_COLOR draws no colour at all', async () => {
    tui = await TuiHarness.start('src/tui-pi/index.ts', 90, 24, [], { env: { NO_COLOR: '1' } });
    await tui.waitFor('connected');
    tui.event('chat.response', { response: '# Heading\n\n**bold** and `code`' });
    await tui.waitFor('Heading');
    expect(colours(tui).size).toBe(0);
  });
});
