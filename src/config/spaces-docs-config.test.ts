import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { spacesConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * The live-document keys of `spaces` (coworking S3, §12.1): schema,
 * defaults, settings registry and the legacy env loader agree.
 */
const EXPECTED = {
  noteMaxBytes: 114_688,
  docMaxUpdatesPerSecond: 30,
  docPersistDebounceMs: 2000,
  docReindexMinutes: 10,
  docBaseTtlMinutes: 30,
  fileLeaseTtlSeconds: 180,
} as const;
const ENV: Record<keyof typeof EXPECTED, string> = {
  noteMaxBytes: 'SPACES_NOTE_MAX_BYTES',
  docMaxUpdatesPerSecond: 'SPACES_DOC_MAX_UPDATES_PER_SECOND',
  docPersistDebounceMs: 'SPACES_DOC_PERSIST_DEBOUNCE_MS',
  docReindexMinutes: 'SPACES_DOC_REINDEX_MINUTES',
  docBaseTtlMinutes: 'SPACES_DOC_BASE_TTL_MINUTES',
  fileLeaseTtlSeconds: 'SPACES_FILE_LEASE_TTL_SECONDS',
};

describe('spaces live-document config', () => {
  afterEach(() => {
    for (const name of Object.values(ENV)) delete process.env[name];
  });

  it.each(Object.entries(EXPECTED))('spaces.%s', (key, value) => {
    const k = key as keyof typeof EXPECTED;
    expect(spacesConfigSchema.parse({})[k]).toBe(value);
    expect(defaultConfig.spaces?.[k]).toBe(value);
    expect(loadFromEnvLegacy().spaces?.[k]).toBe(value);
    const entry = SETTINGS_REGISTRY.find((s) => s.key === `spaces.${key}`);
    expect(entry?.defaultValue).toBe(value);
    expect(entry?.envVar).toBe(ENV[k]);
  });

  it('reads the env vars', () => {
    process.env.SPACES_NOTE_MAX_BYTES = '65536';
    process.env.SPACES_DOC_MAX_UPDATES_PER_SECOND = '10';
    process.env.SPACES_FILE_LEASE_TTL_SECONDS = '60';
    const spaces = loadFromEnvLegacy().spaces;
    expect(spaces?.noteMaxBytes).toBe(65_536);
    expect(spaces?.docMaxUpdatesPerSecond).toBe(10);
    expect(spaces?.fileLeaseTtlSeconds).toBe(60);
  });

  it('the default note fits half the default frame', () => {
    expect(EXPECTED.noteMaxBytes).toBeLessThanOrEqual(262_144 / 2);
  });
});
