import { join, resolve, sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isValidVersion, normalizeVersion, resolveTargetRoot, setCargoVersion, setVersion } from './sync-version';

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
    // Built with `join`/`resolve` rather than written as posix literals: the
    // helper uses `node:path`, so on Windows it answers `\tooling`, and a
    // hard-coded `/tooling` only ever described one of the two platforms.
    const scriptDir = join(sep, 'tooling', 'scripts');
    expect(resolveTargetRoot(undefined, scriptDir)).toBe(join(sep, 'tooling'));
    const override = join(sep, 'release', 'payload');
    expect(resolveTargetRoot(override, scriptDir)).toBe(resolve(override));
  });
});

describe('setCargoVersion', () => {
  const manifest = [
    '[package]',
    'name = "octipus-desktop"',
    'version = "0.1.0"',
    'edition = "2021"',
    '',
    '[dependencies]',
    'serde = { version = "1.0", features = ["derive"] }',
    'tauri = { version = "2.11.3" }',
    '',
  ].join('\n');

  test('rewrites the [package] version', () => {
    expect(setCargoVersion(manifest, '0.5.0')).toContain('version = "0.5.0"');
  });

  test('leaves every dependency version alone', () => {
    // The reason this is not a bare regex: each dependency below carries a
    // `version` too, and rewriting those pins the whole tree to the release.
    const out = setCargoVersion(manifest, '0.5.0');
    expect(out).toContain('serde = { version = "1.0", features = ["derive"] }');
    expect(out).toContain('tauri = { version = "2.11.3" }');
    expect(out.match(/0\.5\.0/g)).toHaveLength(1);
  });

  test('throws when there is no [package] table', () => {
    expect(() => setCargoVersion('[dependencies]\nserde = "1"\n', '0.5.0')).toThrow();
  });
});
