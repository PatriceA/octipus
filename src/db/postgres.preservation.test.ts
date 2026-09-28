import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn());
vi.mock('@electric-sql/pglite', () => ({ PGlite: { create } }));
vi.mock('@electric-sql/pglite-pgvector', () => ({ vector: {} }));
import { initializeDb } from './postgres';

test.each(['PGlite failed to initialize properly', 'could not open file base/5/1: No such file or directory', 'Aborted(). Build with -sASSERTIONS for more info.'])('preserves data after %s instead of recreating the database', async message => {
  const directory = mkdtempSync(join(tmpdir(), 'octipus-preserve-'));
  const marker = join(directory, 'keep-me');
  writeFileSync(marker, 'durable user data');
  vi.stubEnv('STORAGE_MODE', 'embedded');
  vi.stubEnv('DATA_DIR', directory);
  create.mockReset().mockRejectedValue(new Error(message));
  try {
    await expect(initializeDb()).rejects.toThrow('Data was preserved');
    expect(create).toHaveBeenCalledTimes(1);
    expect(readFileSync(marker, 'utf8')).toBe('durable user data');
  } finally { vi.unstubAllEnvs(); }
});
