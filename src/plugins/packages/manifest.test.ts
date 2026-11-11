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
    expect(m.tools?.send_letter.effect).toBe('external');
    expect(m.settings?.[0].key).toBe('region');
  });

  test('mail:send needs an external tool to be handed to', () => {
    const tools = (effect: string) => ({ ...FIXTURE, host: ['mail:read', 'mail:send'], tools: { send_it: { description: 'Sends', effect } } });
    expect(problems(tools('write')).some((p) => p.includes('mail:send is handed only to external tools'))).toBe(true);
    expect(() => parseManifest(tools('external'))).not.toThrow();
    expect(parseManifest({ ...FIXTURE, host: ['mail:read', 'mail:draft', 'calendar:read', 'calendar:write'] }).host).toHaveLength(4);
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

  test('the server may not be started from the signature file', () => {
    expect(problems({ ...FIXTURE, server: { command: 'node', args: ['octipus-plugin.sig'] } })).toEqual([expect.stringMatching(/may not name octipus-plugin\.sig/)]);
    expect(problems({ ...FIXTURE, server: { command: './OCTIPUS-PLUGIN.SIG' } })).toEqual([expect.stringMatching(/may not name/)]);
  });

  describe('runtime', () => {
    const IN_PROCESS = {
      name: 'auditlog', version: '1.0.0', apiVersion: '1.0.0', title: 'Audit log', description: 'Hooks every tool call',
      runtime: 'in-process', entry: 'index.mjs',
    };

    test('package is the default; in-process needs an entry and no server or tools', () => {
      expect(parseManifest(FIXTURE).runtime).toBeUndefined();
      expect(parseManifest({ ...FIXTURE, runtime: 'package' }).runtime).toBe('package');
      const m = parseManifest(IN_PROCESS);
      expect([m.runtime, m.entry, m.server, m.tools]).toEqual(['in-process', 'index.mjs', undefined, undefined]);
      expect(parseManifest({ ...IN_PROCESS, entry: 'dist/plugin.mjs' }).entry).toBe('dist/plugin.mjs');
      expect(problems({ ...IN_PROCESS, runtime: 'wasm' }).length).toBeGreaterThan(0);
    });

    test('a package still needs server and tools, and takes no entry', () => {
      const { server: _s, tools: _t, ...bare } = FIXTURE;
      const found = problems(bare);
      expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/^server: required/), expect.stringMatching(/^tools: required/)]));
      expect(problems({ ...FIXTURE, entry: 'index.mjs' })).toEqual([expect.stringMatching(/^entry: only for runtime "in-process"/)]);
    });

    test('in-process refuses what only a sandbox or a server would give, every problem at once', () => {
      const found = problems({
        ...IN_PROCESS, entry: undefined, server: FIXTURE.server, tools: FIXTURE.tools, network: ['api.example.com'], maxProtection: 2,
        settings: FIXTURE.settings, secrets: FIXTURE.secrets,
      });
      for (const field of ['entry', 'server', 'tools', 'network', 'maxProtection', 'settings', 'secrets']) {
        expect(found.some((p) => p.startsWith(`${field}:`)), field).toBe(true);
      }
    });

    test('the entry is a relative module path inside the package, and the name has no -', () => {
      for (const entry of ['/etc/passwd.js', 'index.ts', 'dist/plugin.cjs', '../x.ts', 'a/../../x.ts', './index.ts', 'index.json', 'octipus-plugin.sig', 'a\\b.ts', '']) {
        expect(problems({ ...IN_PROCESS, entry }).some((p) => p.startsWith('entry:')), entry).toBe(true);
      }
      expect(problems({ ...IN_PROCESS, name: 'audit-log' })).toEqual([expect.stringMatching(/^name: an in-process plugin's name/)]);
    });
  });
});
