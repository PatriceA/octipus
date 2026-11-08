import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { configSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * `plugins.*` (docs/PLUGIN-PACKAGES.md): key expiry and revocation on
 * trusted publishers, `revokedKeys`, and `registries`. Every source of a
 * default agrees, and the schema refuses what the service could not use.
 */
const plugins = (value: unknown) => configSchema.shape.plugins.safeParse(value);
const KEY = 'MCowBQYDK2VwAyEA'.padEnd(60, 'A');
const KEY_ID = `ed25519:${'a'.repeat(64)}`;

describe('plugins config', () => {
  it('defaults agree: schema, defaults, legacy loader, settings registry', () => {
    const parsed = plugins({});
    expect(parsed.success && parsed.data).toEqual({ trustedPublishers: [], revokedKeys: [], requireSignature: false, registries: [] });
    expect(defaultConfig.plugins).toEqual({ trustedPublishers: [], revokedKeys: [], requireSignature: false, registries: [] });
    expect(loadFromEnvLegacy().plugins).toMatchObject({ revokedKeys: [], registries: [] });
    for (const key of ['plugins.trustedPublishers', 'plugins.revokedKeys', 'plugins.requireSignature', 'plugins.registries']) {
      expect(SETTINGS_REGISTRY.find((s) => s.key === key), key).toBeDefined();
    }
  });

  it('a trusted publisher may carry notAfter (an ISO date or date-time with a zone) and revoked', () => {
    for (const notAfter of ['2027-01-01', '2027-01-01T00:00:00Z', '2027-01-01T12:30+02:00']) {
      expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, notAfter }] }).success, notAfter).toBe(true);
    }
    expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, revoked: true }] }).success).toBe(true);
    for (const notAfter of ['next year', '2027-13-45', '01.01.2027', '2027-01-01T00:00']) {
      expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, notAfter }] }).success, notAfter).toBe(false);
    }
  });

  it('revokedKeys are key ids', () => {
    expect(plugins({ revokedKeys: [KEY_ID] }).success).toBe(true);
    expect(plugins({ revokedKeys: ['Acme'] }).success).toBe(false);
    expect(plugins({ revokedKeys: [`ed25519:${'A'.repeat(64)}`] }).success).toBe(false);
  });

  it('registries are named https URLs', () => {
    expect(plugins({ registries: [{ name: 'Acme', url: 'https://plugins.example.com/index.json' }] }).success).toBe(true);
    expect(plugins({ registries: [{ name: 'Acme', url: 'http://plugins.example.com/index.json' }] }).success).toBe(false);
    expect(plugins({ registries: [{ name: '', url: 'https://plugins.example.com/index.json' }] }).success).toBe(false);
    expect(plugins({ registries: [{ name: 'Acme', url: 'not a url' }] }).success).toBe(false);
  });
});
