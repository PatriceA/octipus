import { describe, expect, test } from 'vitest';
import { isValidVersion, normalizeVersion, setVersion } from './sync-version';

describe('normalizeVersion', () => {
  test('strips a leading v', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('0.2.0')).toBe('0.2.0');
  });
});

describe('isValidVersion', () => {
  test('accepts semver-ish versions', () => {
    expect(isValidVersion('0.2.0')).toBe(true);
    expect(isValidVersion('1.10.3')).toBe(true);
    expect(isValidVersion('1.2.3-rc.1')).toBe(true);
    expect(isValidVersion('1.2.3+build.5')).toBe(true);
  });
  test('rejects malformed versions', () => {
    expect(isValidVersion('1.2')).toBe(false);
    expect(isValidVersion('v1.2.3')).toBe(false); // must be pre-normalized
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion('')).toBe(false);
  });
});

describe('setVersion', () => {
  test('replaces only the first version field, preserving formatting', () => {
    const pkg = `{
  "name": "octipus",
  "version": "0.1.0",
  "dependencies": { "x": "1.0.0" }
}`;
    const out = setVersion(pkg, '0.2.0');
    expect(out).toContain('"version": "0.2.0"');
    // Dependency version untouched.
    expect(out).toContain('"x": "1.0.0"');
    // Only one version bumped.
    expect(out.match(/"version": "0\.2\.0"/g)?.length).toBe(1);
    // Rest of the file byte-identical except the version.
    expect(out).toBe(pkg.replace('"version": "0.1.0"', '"version": "0.2.0"'));
  });

  test('tolerates varied spacing', () => {
    expect(setVersion('{"version":"0.1.0"}', '2.0.0')).toBe('{"version":"2.0.0"}');
    expect(setVersion('{ "version" : "0.1.0" }', '2.0.0')).toContain('"2.0.0"');
  });

  test('throws when no version field exists', () => {
    expect(() => setVersion('{"name":"x"}', '1.0.0')).toThrow('no "version" field');
  });
});
