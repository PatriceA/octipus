/**
 * Regression test for the embedded-migrator transient-fault retry.
 *
 * Guards the CI flake fix: migration 0048 (the schema-wide
 * `timestamp`→`timestamptz` table rewrite) intermittently faults inside
 * PGlite's WASM VFS under the full test suite — `could not open file "base/…"`
 * (SQLSTATE 58P01) or a raw `ErrnoError { errno: 44 }` — and a clean replay
 * recovers. These tests pin the retry contract without needing a real PGlite:
 * the exec seam is injected, so we can script exactly which attempt faults.
 */
import { describe, expect, test } from 'bun:test';
import { applyEmbeddedMigrationWithRetry, isTransientPgliteFault } from './migrate';

const noSleep = async () => {};

/** Build an exec stub that fails the FIRST `patchedSql` apply with `err`, then
 *  succeeds, recording the statements it saw. */
function execFailingOnce(err: unknown, sql: string) {
  const calls: string[] = [];
  let sqlApplies = 0;
  const exec = async (query: string): Promise<unknown> => {
    calls.push(query);
    if (query === sql) {
      sqlApplies += 1;
      if (sqlApplies === 1) throw err;
    }
    return undefined;
  };
  return { exec, calls, applyCount: () => sqlApplies };
}

describe('isTransientPgliteFault', () => {
  test('matches the ENOENT ErrnoError PGlite throws', () => {
    expect(isTransientPgliteFault({ name: 'ErrnoError', errno: 44 })).toBe(true);
    expect(isTransientPgliteFault({ errno: 44 })).toBe(true);
  });

  test('matches the "could not open file" / 58P01 storage error', () => {
    expect(isTransientPgliteFault({ code: '58P01' })).toBe(true);
    expect(
      isTransientPgliteFault(new Error('could not open file "base/5/18396": No such file or directory')),
    ).toBe(true);
  });

  test('does NOT match ordinary SQL errors', () => {
    expect(isTransientPgliteFault(new Error('relation "foo" already exists'))).toBe(false);
    expect(isTransientPgliteFault({ code: '42P07' })).toBe(false);
    expect(isTransientPgliteFault(undefined)).toBe(false);
  });
});

describe('applyEmbeddedMigrationWithRetry', () => {
  const SQL = 'ALTER TABLE public.x ALTER COLUMN y TYPE timestamptz';

  test('recovers from a transient VFS fault on the first attempt', async () => {
    const err = { name: 'ErrnoError', errno: 44 };
    const { exec, calls, applyCount } = execFailingOnce(err, SQL);

    await applyEmbeddedMigrationWithRetry('0048', SQL, 'abc123', 42, {
      exec, sleep: noSleep, maxAttempts: 3,
    });

    // Applied twice: the faulting attempt + the successful replay.
    expect(applyCount()).toBe(2);
    // First attempt rolled back before the retry; the run committed exactly once.
    expect(calls.filter((c) => c === 'ROLLBACK')).toHaveLength(1);
    expect(calls.filter((c) => c === 'COMMIT')).toHaveLength(1);
    expect(calls.filter((c) => c === 'BEGIN')).toHaveLength(2);
  });

  test('a non-transient error fails loud on the first attempt (no retry)', async () => {
    const err = new Error('syntax error at or near "ALTR"');
    const { exec, calls, applyCount } = execFailingOnce(err, SQL);

    await expect(
      applyEmbeddedMigrationWithRetry('0048', SQL, 'abc123', 42, {
        exec, sleep: noSleep, maxAttempts: 3,
      }),
    ).rejects.toThrow('syntax error');

    // Tried once, rolled back, did not replay.
    expect(applyCount()).toBe(1);
    expect(calls.filter((c) => c === 'ROLLBACK')).toHaveLength(1);
    expect(calls.filter((c) => c === 'COMMIT')).toHaveLength(0);
  });

  test('gives up (and rethrows) after exhausting all attempts', async () => {
    const err = { name: 'ErrnoError', errno: 44 };
    // Always-faulting exec on the SQL apply.
    let applies = 0;
    const rollbacks: number[] = [];
    const exec = async (query: string): Promise<unknown> => {
      if (query === SQL) { applies += 1; throw err; }
      if (query === 'ROLLBACK') rollbacks.push(1);
      return undefined;
    };

    await expect(
      applyEmbeddedMigrationWithRetry('0048', SQL, 'abc123', 42, {
        exec, sleep: noSleep, maxAttempts: 3,
      }),
    ).rejects.toMatchObject({ errno: 44 });

    // All three attempts ran; each rolled back.
    expect(applies).toBe(3);
    expect(rollbacks).toHaveLength(3);
  });

  test('the happy path commits once with no rollback', async () => {
    const calls: string[] = [];
    const exec = async (query: string): Promise<unknown> => { calls.push(query); return undefined; };

    await applyEmbeddedMigrationWithRetry('0001', SQL, 'deadbeef', 7, {
      exec, sleep: noSleep, maxAttempts: 3,
    });

    expect(calls).toEqual(['BEGIN', SQL, expect.stringContaining('__drizzle_migrations'), 'COMMIT']);
    expect(calls).not.toContain('ROLLBACK');
  });
});
