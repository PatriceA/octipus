/**
 * The manifest's `model` field (manifest-model.ts,
 * docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes): `trustedInput` needs a
 * reason and `model:complete`, and is refused with `web:read` and in-process.
 * Network hosts and `*:read` scopes are allowed, with a warning for the admin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { modelCliToolsSourcesWarning } from '@/shared/plugin-package';
import { ManifestError, parseManifest } from './manifest';
import { modelCliToolsGranted, modelCliToolsView, modelTrustWarnings } from './service';

const HOST = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'host-plugin', 'octipus-plugin.json'), 'utf8'));
const TRUSTED = {
  ...HOST,
  host: ['notes:write', 'model:complete'],
  model: { trustedInput: true, reason: 'Prompts are the package\'s own fixed templates; nothing it reads goes into them.' },
};

function problems(value: unknown): string[] {
  try {
    parseManifest(value);
  } catch (err) {
    if (err instanceof ManifestError) return err.problems;
    throw err;
  }
  throw new Error('expected a ManifestError');
}

describe('model.trustedInput in the manifest', () => {
  test('accepted with model:complete and a reason; absent means untrusted', () => {
    expect(parseManifest(TRUSTED).model).toEqual(TRUSTED.model);
    expect(parseManifest(HOST).model).toBeUndefined();
    // false needs no reason.
    expect(parseManifest({ ...TRUSTED, model: { trustedInput: false } }).model).toEqual({ trustedInput: false });
  });

  test('refused without model:complete', () => {
    expect(problems({ ...TRUSTED, host: ['notes:write'] })).toEqual([expect.stringMatching(/^model\.trustedInput: needs the host scope model:complete/)]);
    const { host: _host, ...noHost } = TRUSTED;
    void _host;
    expect(problems(noHost)).toEqual([expect.stringMatching(/needs the host scope model:complete/)]);
  });

  test('refused with web:read: a fetched page is outside data', () => {
    expect(problems({ ...TRUSTED, host: ['web:read', 'model:complete'] })).toEqual([expect.stringMatching(/^model\.trustedInput: not with the host scope web:read/)]);
  });

  test('refused without a reason, with an empty one or one over 300 characters', () => {
    expect(problems({ ...TRUSTED, model: { trustedInput: true } })).toEqual([expect.stringMatching(/^model\.reason: required with model\.trustedInput/)]);
    expect(problems({ ...TRUSTED, model: { trustedInput: true, reason: '   ' } })).toEqual(expect.arrayContaining([expect.stringMatching(/model\.reason/)]));
    expect(problems({ ...TRUSTED, model: { trustedInput: true, reason: 'x'.repeat(301) } })).toEqual([expect.stringMatching(/model\.reason: at most 300 characters/)]);
    expect(parseManifest({ ...TRUSTED, model: { trustedInput: true, reason: 'x'.repeat(300) } }).model?.reason).toHaveLength(300);
  });

  test('refused on runtime in-process', () => {
    const inProcess = {
      name: 'audit', version: '1.0.0', apiVersion: '1.0.0', title: 'Audit', description: 'An in-process plugin',
      runtime: 'in-process', entry: 'index.mjs', model: { trustedInput: true, reason: 'Fixed prompts.' },
    };
    expect(problems(inProcess)).toEqual([
      expect.stringMatching(/needs the host scope model:complete/),
      expect.stringMatching(/^model\.trustedInput: applies to the package runtime only/),
    ]);
  });

  test('an unknown key under model is refused', () => {
    expect(problems({ ...TRUSTED, model: { ...TRUSTED.model, cliTools: true } }).join(' ')).toMatch(/cliTools/);
  });

  test('network hosts and *:read scopes are allowed, and the admin is warned of them', () => {
    const m = parseManifest({ ...TRUSTED, host: ['notes:read', 'documents:read', 'model:complete'], network: ['api.intranet.example.com'] });
    const warning = modelCliToolsSourcesWarning(m);
    expect(warning).toContain('api.intranet.example.com');
    expect(warning).toContain('notes:read, documents:read');
    expect(modelCliToolsSourcesWarning(parseManifest(TRUSTED))).toBeNull();
    const warnings = modelTrustWarnings(m);
    expect(warnings[0]).toMatch(/model:cli-tools/);
    expect(warnings[0]).toContain('only approve if its prompts never carry outside data');
    expect(warnings[1]).toBe(warning);
    expect(modelTrustWarnings(parseManifest(HOST))).toEqual([]);
  });

  test('granted only when declared and both model:complete and model:cli-tools are approved', () => {
    const manifest = parseManifest(TRUSTED);
    expect(modelCliToolsGranted({ manifest, approvedHostScopes: null })).toBe(false);
    expect(modelCliToolsGranted({ manifest, approvedHostScopes: ['model:complete'] })).toBe(false);
    expect(modelCliToolsGranted({ manifest, approvedHostScopes: ['model:cli-tools'] })).toBe(false);
    expect(modelCliToolsGranted({ manifest, approvedHostScopes: ['model:complete', 'model:cli-tools'] })).toBe(true);
    // Approved, but the manifest does not declare it (it can only be stored by hand): nothing.
    expect(modelCliToolsGranted({ manifest: parseManifest({ ...HOST, host: ['model:complete'] }), approvedHostScopes: ['model:complete', 'model:cli-tools'] })).toBe(false);
    expect(modelCliToolsView({ manifest, approvedHostScopes: ['model:cli-tools'] })).toEqual({
      reason: TRUSTED.model.reason, approved: true, active: false, sourcesWarning: null,
    });
    expect(modelCliToolsView({ manifest: parseManifest(HOST), approvedHostScopes: null })).toBeNull();
  });
});
