import { describe, expect, test } from 'vitest';
import { displayLine, displayText, frameRow } from './terminal-text';

describe('text bound for the terminal', () => {
  test('a multi-line value becomes one row for labels and previews', () => {
    expect(displayLine('for f in *.ts; do\n  wc -l "$f"\ndone')).toBe('for f in *.ts; do wc -l "$f" done');
    expect(displayLine('a\r\nb\rc')).toBe('a b c');
  });

  test('escape sequences from tool output cannot reach the terminal', () => {
    expect(displayText('before\x1b[2J\x1b[Hafter')).toBe('beforeafter');
    expect(displayText('title\x1b]0;owned\x07 done')).toBe('title done');
    expect(displayText('link \x1b]8;;http://x\x1b\\text\x1b]8;;\x1b\\')).toBe('link text');
    expect(displayText('colour \x1b[31mred\x1b[0m')).toBe('colour red');
    expect(displayText('stray \x1b')).toBe('stray ');
  });

  test('newlines survive in multi-line text; other controls do not', () => {
    expect(displayText('one\ntwo\x08\x07\x0b\x0c\x7f')).toBe('one\ntwo');
    expect(displayText('a\tb')).toBe('a    b');
    expect(displayText('日本語 🐙 ok')).toBe('日本語 🐙 ok');
  });

  test('a finished row keeps its styling and loses anything that moves the cursor', () => {
    const styled = '\x1b[1mbold\x1b[22m \x1b_pi:c\x07';
    expect(frameRow(styled)).toBe(styled);
    expect(frameRow('a\nb\rc\td')).toBe('abc d');
  });
});
