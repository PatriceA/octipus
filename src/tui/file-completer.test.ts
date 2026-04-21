import { describe, it, expect } from 'bun:test';
import { extractPathToken } from './path-token';

describe('extractPathToken', () => {
  it('returns null for plain text with no path', () => {
    expect(extractPathToken('hello world')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPathToken('')).toBeNull();
  });

  it('extracts a leading ./ token at end of string', () => {
    const result = extractPathToken('look at ./src/foo');
    expect(result).not.toBeNull();
    expect(result!.token).toBe('./src/foo');
    expect(result!.start).toBe('look at '.length);
  });

  it('extracts a ../ parent-dir token', () => {
    const result = extractPathToken('see ../other');
    expect(result).not.toBeNull();
    expect(result!.token).toBe('../other');
  });

  it('ignores paths that are not at the end of the string', () => {
    // Only the trailing token is returned; middle-of-string paths are not matched.
    const result = extractPathToken('./foo something else');
    // The regex matches the end, so "else" by itself has no leading ./ — should be null.
    expect(result).toBeNull();
  });

  it('handles single-char path after ./', () => {
    const result = extractPathToken('./a');
    expect(result).not.toBeNull();
    expect(result!.token).toBe('./a');
  });

  it('handles nested paths', () => {
    const result = extractPathToken('cat ./src/tui/app.tsx');
    expect(result!.token).toBe('./src/tui/app.tsx');
  });

  it('handles paths with dots in filenames', () => {
    const result = extractPathToken('./foo.test.ts');
    expect(result!.token).toBe('./foo.test.ts');
  });
});
