import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { securityConfigSchema, spacesConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * The S0a/S1/S6 keys (coworking §12.1): `security.trustedProxies`,
 * `security.registration` and the S1 `spaces.*` keys. Every source of a
 * default agrees — schema, defaults, settings registry and the legacy env
 * loader — and each reads its env var.
 */
const SECURITY = {
  trustedProxies: [[], 'TRUSTED_PROXIES'],
  registration: ['open', 'REGISTRATION_MODE'],
} as const;

const SPACES = {
  creation: ['any_user', 'SPACES_CREATION'],
  maxMembers: [50, 'SPACES_MAX_MEMBERS'],
  inviteMaxTtlHours: [720, 'SPACES_INVITE_MAX_TTL_HOURS'],
  purgeAfterArchiveDays: [7, 'SPACES_PURGE_AFTER_ARCHIVE_DAYS'],
} as const;

/** The secrets have no default: a parse needs them. */
const secrets = { masterKey: 'm'.repeat(32), jwtSecret: 'j'.repeat(32), sessionSecret: 's'.repeat(32) };

describe('security and spaces config', () => {
  afterEach(() => {
    for (const [, env] of [...Object.values(SECURITY), ...Object.values(SPACES)]) delete process.env[env];
  });

  it.each(Object.entries(SECURITY))('security.%s', (key, [value, env]) => {
    const k = key as keyof typeof SECURITY;
    expect(securityConfigSchema.parse(secrets)[k]).toEqual(value);
    expect(defaultConfig.security?.[k]).toEqual(value);
    expect(loadFromEnvLegacy().security?.[k]).toEqual(value);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `security.${key}`);
    expect(entry?.defaultValue).toEqual(value);
    expect(entry?.envVar).toBe(env);
  });

  it.each(Object.entries(SPACES))('spaces.%s', (key, [value, env]) => {
    const k = key as keyof typeof SPACES;
    expect(spacesConfigSchema.parse({})[k]).toBe(value);
    expect(defaultConfig.spaces?.[k]).toBe(value);
    expect(loadFromEnvLegacy().spaces?.[k]).toBe(value);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `spaces.${key}`);
    expect(entry?.defaultValue).toBe(value);
    expect(entry?.envVar).toBe(env);
  });

  it('reads the env vars', () => {
    process.env.TRUSTED_PROXIES = '127.0.0.1, 10.0.0.0/8';
    process.env.REGISTRATION_MODE = 'invite_only';
    process.env.SPACES_CREATION = 'admins';
    process.env.SPACES_MAX_MEMBERS = '12';
    process.env.SPACES_INVITE_MAX_TTL_HOURS = '48';
    process.env.SPACES_PURGE_AFTER_ARCHIVE_DAYS = '0';
    const config = loadFromEnvLegacy();
    expect(config.security).toMatchObject({ trustedProxies: ['127.0.0.1', '10.0.0.0/8'], registration: 'invite_only' });
    expect(config.spaces).toMatchObject({ creation: 'admins', maxMembers: 12, inviteMaxTtlHours: 48, purgeAfterArchiveDays: 0 });
  });

  it('refuses values outside the schema', () => {
    expect(() => securityConfigSchema.parse({ ...secrets, trustedProxies: ['not-an-ip'] })).toThrow();
    expect(() => securityConfigSchema.parse({ ...secrets, registration: 'sometimes' })).toThrow();
    expect(() => spacesConfigSchema.parse({ creation: 'nobody' })).toThrow();
    expect(() => spacesConfigSchema.parse({ maxMembers: 1 })).toThrow();
    expect(() => spacesConfigSchema.parse({ inviteMaxTtlHours: 0 })).toThrow();
    expect(() => spacesConfigSchema.parse({ purgeAfterArchiveDays: -1 })).toThrow();
  });
});
