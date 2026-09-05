/** Chat/work split directive — Thread 3. */
import { describe, expect, test } from 'vitest';
import { buildOutputDirective } from './output-directive';

describe('buildOutputDirective', () => {
  test('file mode → asks for a file + summary', () => {
    const out = buildOutputDirective('file', false);
    expect(out).toContain('FILE');
    expect(out).toContain('write_file');
    expect(out).toContain('Files tab');
  });

  test('default inline (not forced) → no instruction, behavior unchanged', () => {
    expect(buildOutputDirective('inline', false)).toBe('');
  });

  test('forced inline → suppresses file creation', () => {
    const out = buildOutputDirective('inline', true);
    expect(out).toContain('INLINE');
    expect(out).toContain('Do not create or write');
  });

  test('forced file behaves like file mode', () => {
    expect(buildOutputDirective('file', true)).toContain('FILE');
  });
});
