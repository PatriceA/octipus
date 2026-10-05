import { describe, expect, test } from 'vitest';
import { applyEdits, merge3, textEdits } from './text-merge';

describe('merge3', () => {
  test('changes on different lines merge', () => {
    expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ ok: true, text: 'A\nb\nC\n' });
  });

  test('changes to different words of one line merge', () => {
    expect(merge3('alpha beta gamma\n', 'ALPHA beta gamma\n', 'alpha beta GAMMA\n')).toEqual({ ok: true, text: 'ALPHA beta GAMMA\n' });
  });

  test('a change next to an append at the end merges', () => {
    expect(merge3('x\nwent well\n', 'x\nwent well\n\ntail\n', 'x\nwent well, more\n')).toEqual({ ok: true, text: 'x\nwent well, more\n\ntail\n' });
  });

  test('two changes to the same word conflict', () => {
    expect(merge3('the cat sat\n', 'the dog sat\n', 'the bird sat\n')).toEqual({ ok: false });
  });

  test('a writer that changed nothing keeps the current text', () => {
    expect(merge3('base', 'current', 'base')).toEqual({ ok: true, text: 'current' });
  });

  test('a large note merges quickly', () => {
    const words: string[] = [];
    for (let i = 0; i < 18_000; i++) words.push(`word${i % 977}${i % 13 === 0 ? '\n' : ' '}`);
    const base = words.join('');
    const started = Date.now();
    const result = merge3(base, `${base.slice(0, 1000)} INSERTED ${base.slice(1000)}`, `${base}\n- captured`);
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('textEdits', () => {
  test('splices only the changed parts', () => {
    const current = 'one\ntwo\nthree\nfour\n';
    const target = 'one\nTWO\nthree\nfour\nfive\n';
    const edits = textEdits(current, target);
    expect(edits).toHaveLength(2);
    expect(applyEdits(current, edits)).toBe(target);
  });

  test('never cuts a surrogate pair', () => {
    const edits = textEdits('a 😀 b', 'a 😃 b');
    expect(edits).toEqual([{ index: 2, remove: 2, insert: '😃' }]);
    expect(applyEdits('a 😀 b', edits)).toBe('a 😃 b');
  });
});
