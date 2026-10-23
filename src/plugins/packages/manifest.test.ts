import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { apiVersionProblem, ManifestError, parseManifest, settingEnvName } from './manifest';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'echo-plugin', 'octipus-plugin.json'), 'utf8'));

function problems(value: unknown): string[] {
  try {
    parseManifest(value);
  } catch (err) {
    if (err instanceof ManifestError) return err.problems;
    throw err;
  }
  throw new Error('expected a ManifestError');
}

describe('plugin manifest', () => {
  test('the fixture fits the contract', () => {
    const m = parseManifest(FIXTURE);
    expect(m.tools.send_letter.effect).toBe('external');
    expect(m.settings?.[0].key).toBe('region');
  });

  test('every problem is reported at once', () => {
    const found = problems({ ...FIXTURE, name: 'Bad Name', version: 'one', tools: { 'bad tool!': { effect: 'delete' } }, network: ['not a host'] });
    expect(found.some((p) => p.startsWith('name:'))).toBe(true);
    expect(found.some((p) => p.startsWith('version:'))).toBe(true);
    expect(found.some((p) => p.includes('tools'))).toBe(true);
    expect(found.some((p) => p.startsWith('network:'))).toBe(true);
  });

  test('unknown keys, reserved names, empty tools and duplicate secrets are refused', () => {
    expect(problems({ ...FIXTURE, extra: 1 }).length).toBeGreaterThan(0);
    expect(problems({ ...FIXTURE, name: 'octipus' })).toContain('name: this name is reserved');
    expect(problems({ ...FIXTURE, tools: {} })).toContain('tools: declare at least one tool');
    expect(problems({ ...FIXTURE, secrets: [{ key: 'A', label: 'a' }, { key: 'A', label: 'b' }] })).toContain('secrets: "A" is declared twice');
    expect(problems({ ...FIXTURE, secrets: [{ key: 'OCTIPUS_SETTING_REGION', label: 'x' }] })).toContain('settings: "region" would collide with the secret OCTIPUS_SETTING_REGION');
  });

  test('apiVersion: same major, minor no newer than the host', () => {
    expect(apiVersionProblem('1.0.0')).toBeNull();
    expect(apiVersionProblem('2.0.0')).toMatch(/not supported/);
    expect(apiVersionProblem('1.9.0')).toMatch(/newer than this host/);
    expect(problems({ ...FIXTURE, apiVersion: '2.0.0' })[0]).toMatch(/not supported/);
  });

  test('settings become OCTIPUS_SETTING_<KEY>', () => {
    expect(settingEnvName('region')).toBe('OCTIPUS_SETTING_REGION');
  });
});
