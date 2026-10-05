import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { roomsConfigSchema, spacesConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * The S2 keys (coworking §12.1): the new `rooms` section and
 * `spaces.memoryMaxItems`. Every source of a default agrees — schema,
 * defaults, settings registry and the legacy env loader.
 */
const ROOMS = {
  maxQueuedPerMember: [3, 'ROOMS_MAX_QUEUED_PER_MEMBER'],
  approvalTimeoutMinutes: [30, 'ROOMS_APPROVAL_TIMEOUT_MINUTES'],
  transcriptWindowChars: [6000, 'ROOMS_TRANSCRIPT_WINDOW_CHARS'],
} as const;

describe('rooms config', () => {
  afterEach(() => {
    for (const [, env] of Object.values(ROOMS)) delete process.env[env];
    delete process.env.SPACES_MEMORY_MAX_ITEMS;
  });

  it.each(Object.entries(ROOMS))('rooms.%s', (key, [value, env]) => {
    const k = key as keyof typeof ROOMS;
    expect(roomsConfigSchema.parse({})[k]).toBe(value);
    expect(defaultConfig.rooms?.[k]).toBe(value);
    expect(loadFromEnvLegacy().rooms?.[k]).toBe(value);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `rooms.${key}`);
    expect(entry?.defaultValue).toBe(value);
    expect(entry?.envVar).toBe(env);
  });

  it('spaces.memoryMaxItems', () => {
    expect(spacesConfigSchema.parse({}).memoryMaxItems).toBe(50);
    expect(defaultConfig.spaces?.memoryMaxItems).toBe(50);
    expect(loadFromEnvLegacy().spaces?.memoryMaxItems).toBe(50);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === 'spaces.memoryMaxItems');
    expect(entry?.defaultValue).toBe(50);
    expect(entry?.envVar).toBe('SPACES_MEMORY_MAX_ITEMS');
  });

  it('reads the env vars', () => {
    process.env.ROOMS_MAX_QUEUED_PER_MEMBER = '5';
    process.env.ROOMS_APPROVAL_TIMEOUT_MINUTES = '10';
    process.env.ROOMS_TRANSCRIPT_WINDOW_CHARS = '9000';
    process.env.SPACES_MEMORY_MAX_ITEMS = '20';
    expect(loadFromEnvLegacy().rooms).toEqual({ maxQueuedPerMember: 5, approvalTimeoutMinutes: 10, transcriptWindowChars: 9000 });
    expect(loadFromEnvLegacy().spaces?.memoryMaxItems).toBe(20);
  });

  it('refuses values that would disable the guard', () => {
    expect(() => roomsConfigSchema.parse({ maxQueuedPerMember: 0 })).toThrow();
    expect(() => roomsConfigSchema.parse({ approvalTimeoutMinutes: 0 })).toThrow();
    expect(() => roomsConfigSchema.parse({ transcriptWindowChars: 10 })).toThrow();
    expect(() => spacesConfigSchema.parse({ memoryMaxItems: 0 })).toThrow();
  });
});
