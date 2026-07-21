import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRATCH_PREFIX, reapCoverageTmp, selectReap } from './tmp-cleanup';

describe('tmp-cleanup selectReap', () => {
  const NOW = 1_000_000_000_000;
  const STALE = 2 * 60 * 60 * 1000;
  const times: Record<string, number | null> = {
    [`${SCRATCH_PREFIX}abandoned`]: NOW - STALE - 1, // > 2h idle
    [`${SCRATCH_PREFIX}fresh`]: NOW - 1000, // this run
    [`${SCRATCH_PREFIX}unreadable`]: null, // stat failed
    'keep-me': NOW - STALE - 1, // no octipus- prefix
  };
  const lastOf = (n: string) => times[n] ?? null;
  const names = Object.keys(times);

  test('load sweep removes only clearly-abandoned octipus-* dirs', () => {
    const reaped = selectReap(names, lastOf, (last) => last < NOW - STALE);
    expect(reaped).toEqual([`${SCRATCH_PREFIX}abandoned`]);
  });

  test('after-all sweep removes only this run\'s dirs, keeps older ones', () => {
    const reaped = selectReap(names, lastOf, (last) => last >= NOW - 5000);
    expect(reaped).toEqual([`${SCRATCH_PREFIX}fresh`]);
  });

  test('never removes a non-octipus dir or one with an unreadable time', () => {
    const reaped = selectReap(names, lastOf, () => true); // "remove everything"
    expect(reaped).not.toContain('keep-me'); // wrong prefix
    expect(reaped).not.toContain(`${SCRATCH_PREFIX}unreadable`); // null time
    expect(reaped.every((n) => n.startsWith(SCRATCH_PREFIX))).toBe(true);
  });
});

describe('tmp-cleanup reapCoverageTmp', () => {
  /** Scratch coverage dir + the callback's cleanup, always removed. */
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}covtmp-`));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Files are written "now", so sweep from a clock far enough ahead that they
  // read as aged out rather than in-flight.
  const LATER = Date.now() + 60 * 60 * 1000;

  test('removes only the leaked .lcov.info.*.tmp files, never the report itself', () => {
    withDir((dir) => {
      for (const name of ['.lcov.info.abc123.tmp', '.lcov.info.def456.tmp', 'lcov.info', 'other.tmp']) {
        writeFileSync(join(dir, name), '');
      }
      expect(reapCoverageTmp(dir, LATER)).toBe(2);
      expect(readdirSync(dir).sort()).toEqual(['lcov.info', 'other.tmp']);
    });
  });

  test('leaves a recent .tmp alone — it may belong to a concurrent test run', () => {
    withDir((dir) => {
      writeFileSync(join(dir, '.lcov.info.inflight.tmp'), '');
      expect(reapCoverageTmp(dir)).toBe(0); // real clock: the file is seconds old
      expect(readdirSync(dir)).toEqual(['.lcov.info.inflight.tmp']);
    });
  });

  test('never removes a directory that happens to match the name pattern', () => {
    withDir((dir) => {
      mkdirSync(join(dir, '.lcov.info.adir.tmp'));
      expect(reapCoverageTmp(dir, LATER)).toBe(0);
      expect(readdirSync(dir)).toEqual(['.lcov.info.adir.tmp']);
    });
  });

  test('is a no-op on a missing coverage dir', () => {
    expect(reapCoverageTmp(join(tmpdir(), `${SCRATCH_PREFIX}does-not-exist-${process.pid}`))).toBe(0);
  });
});
