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
  ['ideographic space', 'a　b'],
  ['emoji', '🐙😀', UNICODE_6],
  ['emoji presentation in the BMP', '✅⌚', UNICODE_6],
  ['text-default symbol', '⚠❤'],
  ['text-default symbol + VS16', '⚠️ ❤️'],
  ['text symbol + VS15', '☺︎'],
  ['lone VS16', 'a️b'],
  ['VS16 at the start of a row', '️b'],
  ['keycap', '1️⃣'],
  ['ZWJ family', '👨‍👩‍👧', UNICODE_6],
  ['ZWJ rainbow flag', '🏳️‍🌈', UNICODE_6],
  ['skin-tone modifier', '👍🏽', UNICODE_6],
  ['lone skin-tone modifier', '🏻', UNICODE_6],
  ['flag (regional indicator pair)', '🇫🇷'],
  ['lone regional indicator', '🇫', { narrower: 'pi-tui reserves two cells for a lone regional indicator, which may still pair while streaming' }],
  ['subdivision flag (tag sequence)', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', UNICODE_6],
  ['combining acute', 'é'],
  ['stacked combining marks', 'á̂̃'],
  ['Hebrew points', 'שָׁ'],
  ['Thai', 'กำ'],
  ['Thai vowel above', 'กั'],
  ['soft hyphen', 'a­b'],
  ['zero-width space', 'a​b'],
  ['ZWJ between letters', 'a‍b'],
  ['ZWNJ (Persian)', 'می‌خواهم'],
  ['Arabic letter mark', 'a؜b'],
  ['bidi marks and overrides', 'a‎‮b‬'],
  ['bidi isolates', 'a⁦b⁩'],
  ['word joiner and invisible operators', 'a⁠⁡b'],
  ['byte-order mark', 'a﻿b'],
  ['Hangul fillers', 'aᅟㅤﾠb'],
  ['Mongolian vowel separator', 'a᠎b'],
  ['ideographic variation selector', '葛\u{e0100}'],
  ['ambiguous width: ± ① ─ ● … α ж', '± ① ─ ● … α ж'],
  ['private use', 'ab'],
  ['replacement character', 'a�b'],
  ['mathematical bold', '𝐀𝐁'],
  ['Devanagari conjunct with a spacing vowel sign', 'क्षि', { wider: 'pi-tui gives a spacing mark (Mc) no cells; terminals draw it in its own cell. Not normalised: removing or replacing the mark corrupts the script' }],
  ['Devanagari visarga', 'aःb', { wider: 'spacing mark (Mc), as above' }],
  ['Tibetan spacing mark', 'aཿb', { wider: 'spacing mark (Mc), as above' }],
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

describe('what displayText changes for width', () => {
  test('emoji joiners and modifiers come apart; invisible format characters go', () => {
    expect(displayText('👨‍👩‍👧')).toBe('👨👩👧');
    expect(displayText('👍🏽 ok')).toBe('👍 ok');
    expect(displayText('⚠️ careful')).toBe('⚠ careful');
    expect(displayText('a­‮⁦b')).toBe('ab');
  });

  test('joiners that shape scripts stay', () => {
    expect(displayText('می‌خواهم')).toBe('می‌خواهم');
    expect(displayText('क्‍ष')).toBe('क्‍ष');
  });
});
