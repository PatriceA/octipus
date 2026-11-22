/** Search in the real editor: replace one at a time, and across the project (docs/plans/tui-modernization.md §7, Phase 5 item 3). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { KEY, TuiHarness } from './harness';
let tui: TuiHarness | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => { await tui?.stop(); tui = undefined; cleanup?.(); cleanup = undefined; });

const hasRg = (() => { try { execFileSync('rg', ['--version']); return true; } catch { return false; } })();

/** A PATH with Node and the PTY relay's python3 but no ripgrep. */
function pathWithoutRg(): { path: string; dispose: () => void } {
  const bin = mkdtempSync(join(tmpdir(), 'tui-no-rg-'));
  symlinkSync(execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(), join(bin, 'python3'));
  return { path: `${bin}:${dirname(process.execPath)}`, dispose: () => rmSync(bin, { recursive: true, force: true }) };
}

describe.skipIf(process.platform === 'win32')('search in a real POSIX terminal', () => {
  for (const withRg of [true, false]) {
    test.skipIf(withRg && !hasRg)(`project search with ${withRg ? 'ripgrep' : 'the project index, ripgrep not on PATH'}: results with a preview, Enter opens the file at the match`, async () => {
      const noRg = withRg ? null : pathWithoutRg();
      tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 30, [], { env: noRg ? { PATH: noRg.path } : {} });
      cleanup = noRg?.dispose;
      mkdirSync(join(tui.project, 'src'));
      writeFileSync(join(tui.project, 'src', 'deep.ts'), `${Array.from({ length: 40 }, (_, i) => `// filler ${i}`).join('\n')}\nexport const needleValue = 42;\n`);
      await tui.waitFor('focus:editor');
      tui.send('\x1bg'); await tui.waitFor('Search the project');
      tui.send('needleValue'); tui.send(KEY.Enter);
      await tui.waitFor('1 match in 1 file');
      expect(await tui.text()).toContain(withRg ? 'ripgrep' : 'project index');
      await tui.waitFor('src/deep.ts:41');
      await tui.waitFor('// filler 39'); // the preview's context line above the match
      await tui.saveScreen(`editor-project-search-${withRg ? 'rg' : 'walk'}`);
      tui.send(KEY.Enter);
      await tui.waitFor('Search the project', true);
      await tui.waitFor('L41:14');
      expect(await tui.text()).toContain(' deep.ts ×');
    });
  }

  test('replace one at a time: Alt+Enter replaces the current match and moves on', async () => {
    tui = await TuiHarness.start('src/tui-editor/index.ts', 120, 30);
    writeFileSync(join(tui.project, 'example.ts'), 'old one\nold two\nold three\n');
    await tui.waitFor('focus:editor');
    tui.send(KEY.CtrlO); await tui.waitFor('Open file'); tui.send('example.ts'); tui.send(KEY.Enter); await tui.waitFor('old one');
    tui.send('\x1br'); await tui.waitFor('Replace');
    tui.send('old'); await tui.waitFor('Replace 1 / 3');
    tui.send('\t'); tui.send('new');
    await tui.waitFor('L1 old→new one');
    tui.send('\x1b\r'); await tui.waitFor('new one');
    await tui.waitFor('Replace 1 / 2');
    tui.send('\x1b[B'); await tui.waitFor('Replace 2 / 2');
    tui.send('\x1b\r'); await tui.waitFor('new three');
    expect(await tui.text()).toContain('old two');
    tui.send(KEY.Esc); await tui.waitFor('Replaced 2 occurrences');
  });
});
