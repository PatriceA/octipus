import { describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { configSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * `plugins.*` (docs/PLUGIN-PACKAGES.md): key expiry and revocation on
 * trusted publishers, `revokedKeys`, `registries` and `hostModelDailyTokens`. Every source of a
 * default agrees, and the schema refuses what the service could not use.
 */
const plugins = (value: unknown) => configSchema.shape.plugins.safeParse(value);
const KEY = 'MCowBQYDK2VwAyEA'.padEnd(60, 'A');
const KEY_ID = `ed25519:${'a'.repeat(64)}`;

describe('plugins config', () => {
  it('defaults agree: schema, defaults, legacy loader, settings registry', () => {
    const parsed = plugins({});
    const defaults = { trustedPublishers: [], revokedKeys: [], requireSignature: false, registries: [], hostModelDailyTokens: 200_000 };
    expect(parsed.success && parsed.data).toEqual(defaults);
    expect(defaultConfig.plugins).toEqual(defaults);
    expect(loadFromEnvLegacy().plugins).toMatchObject({ revokedKeys: [], registries: [], hostModelDailyTokens: 200_000 });
    expect(SETTINGS_REGISTRY.find((s) => s.key === 'plugins.hostModelDailyTokens')?.defaultValue).toBe(200_000);
    for (const key of ['plugins.trustedPublishers', 'plugins.revokedKeys', 'plugins.requireSignature', 'plugins.registries', 'plugins.hostModelDailyTokens']) {
      expect(SETTINGS_REGISTRY.find((s) => s.key === key), key).toBeDefined();
    }
  });

  it('a trusted publisher may carry notAfter (an ISO date or date-time with a zone) and revoked', () => {
    for (const notAfter of ['2027-01-01', '2027-01-01T00:00:00Z', '2027-01-01T12:30+02:00']) {
      expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, notAfter }] }).success, notAfter).toBe(true);
    }
    expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, revoked: true }] }).success).toBe(true);
    for (const notAfter of ['next year', '2027-13-45', '2027-02-30', '2027-04-31T00:00:00Z', '01.01.2027', '2027-01-01T00:00']) {
      expect(plugins({ trustedPublishers: [{ name: 'Acme', publicKey: KEY, notAfter }] }).success, notAfter).toBe(false);
    }
  });

  it('hostModelDailyTokens is a whole number of tokens, 0 to turn plugin model calls off', () => {
    expect(plugins({ hostModelDailyTokens: 0 }).success).toBe(true);
    expect(plugins({ hostModelDailyTokens: -1 }).success).toBe(false);
    expect(plugins({ hostModelDailyTokens: 1.5 }).success).toBe(false);
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

  it('a registry may name the publisher whose signature its index must carry', () => {
    expect(plugins({ registries: [{ name: 'Acme', url: 'https://plugins.example.com/index.json', publisher: 'Acme' }] }).success).toBe(true);
    expect(plugins({ registries: [{ name: 'Acme', url: 'https://plugins.example.com/index.json', publisher: '' }] }).success).toBe(false);
  });
});
