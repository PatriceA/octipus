import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { gatewayConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * The `gateway` section (coworking S0d): every source of a default agrees —
 * schema, defaults, settings registry and the legacy env loader — or the one
 * that loads last silently wins.
 */
const EXPECTED = {
  maxConnectionsPerUser: 20,
  maxFrameBytes: 262_144,
  replayMaxSessions: 500,
} as const;
const ENV: Record<keyof typeof EXPECTED, string> = {
  maxConnectionsPerUser: 'GATEWAY_MAX_CONNECTIONS_PER_USER',
  maxFrameBytes: 'GATEWAY_MAX_FRAME_BYTES',
  replayMaxSessions: 'GATEWAY_REPLAY_MAX_SESSIONS',
};

describe('gateway config', () => {
  afterEach(() => {
    for (const name of Object.values(ENV)) delete process.env[name];
  });

  it.each(Object.entries(EXPECTED))('gateway.%s', (key, value) => {
    const k = key as keyof typeof EXPECTED;
    expect(gatewayConfigSchema.parse({})[k]).toBe(value);
    expect(defaultConfig.gateway?.[k]).toBe(value);
    expect(loadFromEnvLegacy().gateway?.[k]).toBe(value);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `gateway.${key}`);
    expect(entry?.defaultValue).toBe(value);
    expect(entry?.envVar).toBe(ENV[k]);
  });

  it('reads the env vars', () => {
    process.env.GATEWAY_MAX_CONNECTIONS_PER_USER = '3';
    process.env.GATEWAY_MAX_FRAME_BYTES = '65536';
    process.env.GATEWAY_REPLAY_MAX_SESSIONS = '7';
    expect(loadFromEnvLegacy().gateway).toEqual({ maxConnectionsPerUser: 3, maxFrameBytes: 65_536, replayMaxSessions: 7 });
  });

  it('refuses values that would disable the guard', () => {
    expect(() => gatewayConfigSchema.parse({ maxConnectionsPerUser: 0 })).toThrow();
    expect(() => gatewayConfigSchema.parse({ maxFrameBytes: 1024 })).toThrow();
    expect(() => gatewayConfigSchema.parse({ replayMaxSessions: 0 })).toThrow();
  });
});
