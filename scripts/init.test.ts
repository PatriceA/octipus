import { describe, expect, test } from 'bun:test';
import { buildEnv } from './init';

/**
 * The interactive flow uses pi-tui and a real TUI — exercising it
 * requires a PTY harness, which lives in the dedicated TUI e2e suite
 * (tests/tui). Here we just verify the pure .env builder.
 */

const KEYS = {
  masterKey: 'm'.repeat(44),
  jwtSecret: 'j'.repeat(44),
  sessionSecret: 's'.repeat(44),
};

describe('init — buildEnv', () => {
  test('embedded mode emits DATA_DIR, no DATABASE_URL', () => {
    const env = buildEnv({
      storageMode: 'embedded',
      databaseUrl: '',
      redisUrl: '',
      dataDir: '/tmp/data',
      port: '3005',
      host: '127.0.0.1',
      bootstrapProvider: '',
      bootstrapModel: '',
      bootstrapApiKey: '',
      bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).toContain('STORAGE_MODE=embedded');
    expect(env).toContain('DATA_DIR=/tmp/data');
    expect(env).not.toContain('DATABASE_URL=');
  });

  test('external mode emits DATABASE_URL + REDIS_URL', () => {
    const env = buildEnv({
      storageMode: 'external',
      databaseUrl: 'postgresql://u:p@h:5432/db',
      redisUrl: 'redis://h:6379',
      dataDir: '',
      port: '3005',
      host: '127.0.0.1',
      bootstrapProvider: '',
      bootstrapModel: '',
      bootstrapApiKey: '',
      bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).toContain('STORAGE_MODE=external');
    expect(env).toContain('DATABASE_URL=postgresql://u:p@h:5432/db');
    expect(env).toContain('REDIS_URL=redis://h:6379');
    expect(env).not.toContain('DATA_DIR=');
  });

  test('always emits security keys', () => {
    const env = buildEnv({
      storageMode: 'embedded',
      databaseUrl: '', redisUrl: '', dataDir: '/x',
      port: '3005', host: 'localhost',
      bootstrapProvider: '', bootstrapModel: '', bootstrapApiKey: '', bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).toContain(`MASTER_KEY=${KEYS.masterKey}`);
    expect(env).toContain(`JWT_SECRET=${KEYS.jwtSecret}`);
    expect(env).toContain(`SESSION_SECRET=${KEYS.sessionSecret}`);
  });

  test('bootstrap provider + model land when set', () => {
    const env = buildEnv({
      storageMode: 'embedded',
      databaseUrl: '', redisUrl: '', dataDir: '/x',
      port: '3005', host: 'localhost',
      bootstrapProvider: 'ollama',
      bootstrapModel: 'llama3.2:3b',
      bootstrapApiKey: '',
      bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).toContain('BOOTSTRAP_PROVIDER=ollama');
    expect(env).toContain('BOOTSTRAP_MODEL=llama3.2:3b');
    expect(env).not.toContain('BOOTSTRAP_API_KEY=');
  });

  test('bootstrap API key + base URL only when present', () => {
    const env = buildEnv({
      storageMode: 'embedded',
      databaseUrl: '', redisUrl: '', dataDir: '/x',
      port: '3005', host: 'localhost',
      bootstrapProvider: 'openrouter',
      bootstrapModel: 'openai/gpt-4o-mini',
      bootstrapApiKey: 'sk-test-redacted',
      bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).toContain('BOOTSTRAP_API_KEY=sk-test-redacted');
    expect(env).not.toContain('BOOTSTRAP_BASE_URL=');
  });

  test('skip path — no BOOTSTRAP_* block at all', () => {
    const env = buildEnv({
      storageMode: 'embedded',
      databaseUrl: '', redisUrl: '', dataDir: '/x',
      port: '3005', host: 'localhost',
      bootstrapProvider: '',
      bootstrapModel: '',
      bootstrapApiKey: '',
      bootstrapBaseUrl: '',
    }, KEYS);
    expect(env).not.toContain('BOOTSTRAP_PROVIDER');
    expect(env).not.toContain('BOOTSTRAP_MODEL');
  });
});
