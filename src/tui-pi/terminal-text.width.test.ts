/**
 * Width audit: for text that went through `displayText`, the width pi-tui
 * measures must be the width the terminal draws. A row the terminal draws
 * wider than pi-tui measured wraps, and every row after it lands one row low
 * — the failure behind the vanishing composer, from a different cause.
 *
 * The terminal here is @xterm/headless, the one the PTY suites use. Its
 * width tables are Unicode 6 (it ships no newer provider without an addon),
 * so it draws emoji one cell wide where current terminals and pi-tui use two.
 * That direction is safe — the row is narrower than measured, so it cannot
 * wrap — and those rows are pinned below as `narrower` rather than skipped.
 *
 * `wider` rows are the dangerous direction and are what remains unsolved;
 * see the note on each.
 */
import xterm from '@xterm/headless';
import { visibleWidth } from '@mariozechner/pi-tui';
import { afterAll, describe, expect, test } from 'vitest';
import { displayText } from './terminal-text';

const { Terminal } = xterm;
const terminal = new Terminal({ cols: 200, rows: 2, allowProposedApi: true });
afterAll(() => terminal.dispose());

async function cells(text: string): Promise<number> {
  await new Promise<void>(resolve => terminal.write(`\x1b[2J\x1b[H${text}`, resolve));
  return terminal.buffer.active.cursorX;
}

type Known = { narrower: string } | { wider: string };
const UNICODE_6 = { narrower: 'xterm-headless draws emoji one cell (Unicode 6 tables); pi-tui and current terminals draw two' };

// Each input is framed by letters so a zero-width character cannot hide at the start of the row.
const CASES: Array<[label: string, input: string, known?: Known]> = [
  ['ASCII', 'abc'],
  ['CJK', '世界'],
  ['Hangul', '한국어'],
  ['fullwidth Latin', 'Ａｂ'],
  ['halfwidth katakana', 'ｱｲ'],
  ['CJK extension B', '𠀀'],
  ['ideographic space', 'a\u3000b'],
  ['emoji', '🐙😀', UNICODE_6],
  ['emoji presentation in the BMP', '✅⌚', UNICODE_6],
  ['text-default symbol', '⚠❤'],
  ['text-default symbol + VS16', '⚠\ufe0f ❤\ufe0f'],
  ['text symbol + VS15', '☺\ufe0e'],
  ['lone VS16', 'a\ufe0fb'],
  ['VS16 at the start of a row', '\ufe0fb'],
  ['keycap', '1\ufe0f\u20e3'],
  ['ZWJ family', '👨\u200d👩\u200d👧', UNICODE_6],
  ['ZWJ rainbow flag', '🏳\ufe0f\u200d🌈', UNICODE_6],
  ['skin-tone modifier', '👍\u{1f3fd}', UNICODE_6],
  ['lone skin-tone modifier', '\u{1f3fb}', UNICODE_6],
  ['flag (regional indicator pair)', '🇫🇷'],
  ['lone regional indicator', '🇫', { narrower: 'pi-tui reserves two cells for a lone regional indicator, which may still pair while streaming' }],
  ['subdivision flag (tag sequence)', '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', UNICODE_6],
  ['combining acute', 'e\u0301'],
  ['stacked combining marks', 'a\u0301\u0302\u0303'],
  ['combining marks with no base', '\u0301\u0302x'],
  ['combining mark left behind by a removed escape', '\x1ba\u0301x'],
  ['Hebrew points', 'ש\u05b8\u05c1'],
  ['Thai', 'กำ'],
  ['Thai vowel above', 'ก\u0e31'],
  ['soft hyphen', 'a\u00adb'],
  ['zero-width space', 'a\u200bb'],
  ['ZWJ between letters', 'a\u200db'],
  ['ZWNJ (Persian)', 'می\u200cخواهم'],
  ['Arabic letter mark', 'a\u061cb'],
  ['bidi marks and overrides', 'a\u200e\u202eb\u202c'],
  ['bidi isolates', 'a\u2066b\u2069'],
  ['word joiner and invisible operators', 'a\u2060\u2061b'],
  ['byte-order mark', 'a\ufeffb'],
  ['Hangul fillers', 'a\u115f\u3164\uffa0b'],
  ['Mongolian vowel separator', 'a\u180eb'],
  ['ideographic variation selector', '葛\u{e0100}'],
  ['ambiguous width: ± ① ─ ● … α ж', '± ① ─ ● … α ж'],
  ['private use', 'a\ue000b'],
  ['replacement character', 'a�b'],
  ['mathematical bold', '𝐀𝐁'],
  ['Devanagari conjunct with a spacing vowel sign', 'क\u094dष\u093f', { wider: 'pi-tui gives a spacing mark (Mc) no cells; terminals draw it in its own cell. Not normalised: removing or replacing the mark corrupts the script' }],
  ['Devanagari visarga', 'a\u0903b', { wider: 'spacing mark (Mc), as above' }],
  ['Tibetan spacing mark', 'a\u0f7fb', { wider: 'spacing mark (Mc), as above' }],
];

describe('pi-tui measures what the terminal draws, after displayText', () => {
  test.each(CASES)('%s', async (_label, input, known) => {
    const shown = displayText(input);
    const drawn = await cells(shown);
    const measured = visibleWidth(shown);
    if (!known) expect(drawn).toBe(measured);
    else if ('narrower' in known) expect(drawn).toBeLessThan(measured);
    else expect(drawn).toBeGreaterThan(measured);
  });
});

test('a row that starts with styling and then displayed text measures the same', async () => {
  // Every component styles the start of its rows (borders, the transcript rail);
  // xterm.js does not combine a mark across a styling sequence.
  const row = `\x1b[31m│ \x1b[39m${displayText('\u0301\u0302 tail')}`;
  expect(await cells(row)).toBe(visibleWidth(row));
});

describe('what displayText changes for width', () => {
  test('emoji joiners and modifiers come apart; invisible format characters go', () => {
    expect(displayText('👨\u200d👩\u200d👧')).toBe('👨👩👧');
    expect(displayText('👍\u{1f3fd} ok')).toBe('👍 ok');
    expect(displayText('⚠\ufe0f careful')).toBe('⚠ careful');
    expect(displayText('a\u00ad\u202e\u2066b')).toBe('ab');
  });

  test('a combining mark with nothing to combine with is put on a no-break space', () => {
    expect(displayText('\u0301\u0302x\n\u0301y\nz\u0301')).toBe('\u00a0\u0301\u0302x\n\u00a0\u0301y\nz\u0301');
  });

  test('joiners that shape scripts stay', () => {
    expect(displayText('می\u200cخواهم')).toBe('می\u200cخواهم');
    expect(displayText('क\u094d\u200dष')).toBe('क\u094d\u200dष');
  });
});
