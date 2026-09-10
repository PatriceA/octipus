import { describe, expect, test } from 'vitest';
import { isValidVersion, normalizeVersion, resolveTargetRoot, setVersion } from './sync-version';

describe('normalizeVersion', () => {
  test('strips a leading v', () => {
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0');
    expect(normalizeVersion('0.2.0')).toBe('0.2.0');
  });

  test('expands a two-component release tag', () => {
    expect(normalizeVersion('v0.3')).toBe('0.3.0');
    expect(normalizeVersion('  12.34  ')).toBe('12.34.0');
    expect(normalizeVersion('v1.2-rc.1')).toBe('1.2.0-rc.1');
    expect(normalizeVersion('v1.2+build.5')).toBe('1.2.0+build.5');
  });

  test('leaves malformed and complete versions for validation', () => {
    expect(normalizeVersion('v1')).toBe('1');
    expect(normalizeVersion('v1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeVersion('v1.two')).toBe('1.two');
    expect(normalizeVersion('v1.2-')).toBe('1.2-');
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

describe('resolveTargetRoot', () => {
  test('defaults to the repository above the helper and accepts a payload override', () => {
    expect(resolveTargetRoot(undefined, '/tooling/scripts')).toBe('/tooling');
    expect(resolveTargetRoot('/release/payload', '/tooling/scripts')).toBe('/release/payload');
  });
});
