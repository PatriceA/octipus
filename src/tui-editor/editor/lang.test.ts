import { describe, expect, test } from 'bun:test';
import { detectLanguage } from './lang';

describe('detectLanguage', () => {
  test('common extensions', () => {
    expect(detectLanguage('foo.ts')).toBe('typescript');
    expect(detectLanguage('foo.tsx')).toBe('tsx');
    expect(detectLanguage('foo.js')).toBe('javascript');
    expect(detectLanguage('foo.py')).toBe('python');
    expect(detectLanguage('foo.rs')).toBe('rust');
    expect(detectLanguage('foo.go')).toBe('go');
    expect(detectLanguage('foo.json')).toBe('json');
    expect(detectLanguage('foo.md')).toBe('markdown');
    expect(detectLanguage('foo.sh')).toBe('shell');
  });

  test('unknown extension falls back to text', () => {
    expect(detectLanguage('foo.xyz')).toBe('text');
    expect(detectLanguage('Makefile.bak')).toBe('text');
  });

  test('special filenames', () => {
    expect(detectLanguage('/path/to/Dockerfile')).toBe('shell');
    expect(detectLanguage('Makefile')).toBe('shell');
  });

  test('case-insensitive', () => {
    expect(detectLanguage('Foo.TS')).toBe('typescript');
  });
});
