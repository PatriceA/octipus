/**
 * @octipus/plugin-sdk contract tests (WS3). Imported via the tsconfig alias so
 * the host and authors validate against the same definitions.
 */
import { describe, expect, test } from 'vitest';
import {
  checkApiVersion,
  generateFixtureArgs,
  manifestTools,
  PLUGIN_API_VERSION,
  parseSemver,
  type PluginManifest,
  validateManifest,
} from '@octipus/plugin-sdk';

const baseManifest = {
  name: 'p',
  version: '1.0.0',
  description: 'd',
  main: 'index.ts',
  apiVersion: '1.0.0',
  tools: [{ name: 't', description: 'd', parameters: {} }],
};

describe('validateManifest', () => {
  test('accepts a well-formed manifest', () => {
    const r = validateManifest(baseManifest);
    expect(r.ok).toBe(true);
  });

  test('collects every structural error at once', () => {
    const r = validateManifest({ tools: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"name"'),
          expect.stringContaining('"version"'),
          expect.stringContaining('"main"'),
          expect.stringContaining('"tools" must be an array'),
        ]),
      );
    }
  });

  test('accepts capabilities.tools instead of top-level tools', () => {
    const r = validateManifest({
      name: 'p', version: '1.0.0', description: 'd', main: 'i.ts',
      capabilities: { tools: [{ name: 't', description: 'd', parameters: {} }] },
    });
    expect(r.ok).toBe(true);
  });

  test('rejects a tool missing required fields', () => {
    const r = validateManifest({ ...baseManifest, tools: [{ description: 'no name', parameters: {} }] });
    expect(r.ok).toBe(false);
  });

  test('rejects a secrets map with an empty value', () => {
    const r = validateManifest({ ...baseManifest, secrets: { key: '' } });
    expect(r.ok).toBe(false);
  });
});

describe('checkApiVersion', () => {
  test('same version is compatible', () => {
    expect(checkApiVersion(PLUGIN_API_VERSION).ok).toBe(true);
  });
  test('missing apiVersion is legacy-allowed (with a warning)', () => {
    const r = checkApiVersion(undefined);
    expect(r.ok).toBe(true);
    expect(r.legacy).toBe(true);
  });
  test('a different MAJOR is refused', () => {
    expect(checkApiVersion('2.0.0').ok).toBe(false);
    expect(checkApiVersion('0.9.0').ok).toBe(false);
  });
  test('a newer MINOR than the host is refused', () => {
    const host = parseSemver(PLUGIN_API_VERSION)!;
    expect(checkApiVersion(`${host.major}.${host.minor + 1}.0`).ok).toBe(false);
  });
  test('malformed version is refused', () => {
    expect(checkApiVersion('not-a-version').ok).toBe(false);
  });
});

describe('manifestTools', () => {
  test('prefers capabilities.tools over the top-level tools', () => {
    const m = {
      ...baseManifest,
      tools: [{ name: 'old', description: 'd', parameters: {} }],
      capabilities: { tools: [{ name: 'new', description: 'd', parameters: {} }] },
    } as PluginManifest;
    expect(manifestTools(m).map((t) => t.name)).toEqual(['new']);
  });
  test('falls back to top-level tools', () => {
    expect(manifestTools(baseManifest as PluginManifest).map((t) => t.name)).toEqual(['t']);
  });
});

describe('generateFixtureArgs', () => {
  test('produces a value per param, honoring type and defaults', () => {
    const args = generateFixtureArgs({
      s: { type: 'string', description: '' },
      n: { type: 'number', description: '' },
      b: { type: 'boolean', description: '' },
      arr: { type: 'array', description: '' },
      obj: { type: 'object', description: '' },
      d: { type: 'string', description: '', default: 'preset' },
    });
    expect(args).toEqual({ s: 'test', n: 1, b: true, arr: [], obj: {}, d: 'preset' });
  });
});
