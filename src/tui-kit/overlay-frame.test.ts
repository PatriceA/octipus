import { expect, test } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { boxRow, drawBox, fitBoxWidth, padToWidth } from './overlay-frame';

const plain = (text: string) => text;

test('a box puts a border around each section with a separator between them', () => {
  expect(drawBox([['head'], ['one', 'two']], 10, plain)).toEqual([
    '┌────────┐',
    '│ head   │',
    '├────────┤',
    '│ one    │',
    '│ two    │',
    '└────────┘',
  ]);
});

test('every row is the box width: long rows are cut, wide characters counted in cells', () => {
  const rows = drawBox([['a row much longer than the box', '世界', '\x1b[31mred\x1b[0m']], 12, plain);
  expect(rows.map(row => visibleWidth(row))).toEqual([12, 12, 12, 12, 12]);
  expect(boxRow('世界', 12, plain)).toBe('│ 世界     │');
});

test('the border is painted, the text is not', () => {
  expect(boxRow('x', 6, text => `<${text}>`)).toBe('<│ >x < │>');
});

test('a box fits its widest row, capped by the space available', () => {
  expect(fitBoxWidth(['ab', 'abcdef'], 80)).toBe(10);
  expect(fitBoxWidth(['ab', 'abcdef'], 8)).toBe(8);
  expect(fitBoxWidth(['ab'], 80, 40)).toBe(44);
  expect(padToWidth('ab', 4)).toBe('ab  ');
  expect(padToWidth('abcdef', 4)).toBe('abcdef');
});
