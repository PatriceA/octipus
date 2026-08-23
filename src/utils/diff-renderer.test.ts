import { describe, expect, test } from 'vitest';
import { renderUnifiedDiff } from './diff-renderer';

describe('renderUnifiedDiff', () => {
  test('identical inputs return empty', () => {
    expect(renderUnifiedDiff('a\nb\nc\n', 'a\nb\nc\n', { color: 'never' })).toBe('');
  });

  test('addition only', () => {
    const d = renderUnifiedDiff('a\nb\n', 'a\nb\nc\n', { color: 'never' });
    expect(d).toContain('+c');
    // No deletion lines (lines starting with '-') beyond the hunk header '-N,M'.
    expect(d).not.toMatch(/^-[a-z]/m);
    expect(d).toMatch(/@@ -/);
  });

  test('deletion only', () => {
    const d = renderUnifiedDiff('a\nb\nc\n', 'a\nb\n', { color: 'never' });
    expect(d).toContain('-c');
    expect(d).not.toMatch(/^\+/m);
  });

  test('mixed change', () => {
    const d = renderUnifiedDiff('a\nb\nc\n', 'a\nx\nc\n', { color: 'never' });
    expect(d).toContain('-b');
    expect(d).toContain('+x');
  });

  test('multiline block change', () => {
    const before = ['one', 'two', 'three', 'four'].join('\n');
    const after  = ['one', 'TWO', 'THREE', 'four'].join('\n');
    const d = renderUnifiedDiff(before, after, { color: 'never' });
    expect(d).toContain('-two');
    expect(d).toContain('+TWO');
    expect(d).toContain('-three');
    expect(d).toContain('+THREE');
  });

  test('color off omits ANSI', () => {
    const d = renderUnifiedDiff('a\n', 'b\n', { color: 'never' });
    expect(d).not.toContain('\u001b[');
  });

  test('color always emits ANSI', () => {
    const d = renderUnifiedDiff('a\n', 'b\n', { color: 'always' });
    expect(d).toContain('\u001b[');
  });

  test('filename header emitted when provided', () => {
    const d = renderUnifiedDiff('a\n', 'b\n', { filename: 'foo.ts', color: 'never' });
    expect(d).toContain('--- a/foo.ts');
    expect(d).toContain('+++ b/foo.ts');
  });

  test('context window respected', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const after = before.replace('line10', 'LINE10');
    const d = renderUnifiedDiff(before, after, { context: 1, color: 'never' });
    const lines = d.split('\n');
    const eqLines = lines.filter(l => l.startsWith(' '));
    expect(eqLines.length).toBeLessThanOrEqual(2); // 1 before + 1 after
  });
});
