import { describe, expect, test } from 'vitest';
import { diffLines, diffStats } from './diff';

describe('diffLines', () => {
  test('identical inputs produce all keeps', () => {
    const h = diffLines('a\nb\nc', 'a\nb\nc');
    expect(h.every((x) => x.op === 'keep')).toBe(true);
  });

  test('pure addition', () => {
    const h = diffLines('a\nb', 'a\nb\nc');
    expect(h.length).toBe(3);
    expect(h[2].op).toBe('add');
    expect(h[2].text).toBe('c');
  });

  test('pure deletion', () => {
    const h = diffLines('a\nb\nc', 'a\nc');
    expect(h.find((x) => x.op === 'del')?.text).toBe('b');
  });

  test('replacement = del + add', () => {
    const h = diffLines('a\nb\nc', 'a\nX\nc');
    const ops = h.map((x) => x.op);
    expect(ops).toContain('del');
    expect(ops).toContain('add');
    expect(h.find((x) => x.op === 'del')?.text).toBe('b');
    expect(h.find((x) => x.op === 'add')?.text).toBe('X');
  });

  test('handles empty before', () => {
    const h = diffLines('', 'hello');
    expect(h.every((x) => x.op === 'add' || (x.op === 'keep' && x.text === '') || x.op === 'del')).toBe(true);
  });

  test('diffStats counts adds + dels', () => {
    const h = diffLines('a\nb\nc', 'a\nX\nY\nc');
    const stats = diffStats(h);
    expect(stats.dels).toBe(1);
    expect(stats.adds).toBe(2);
  });
});
