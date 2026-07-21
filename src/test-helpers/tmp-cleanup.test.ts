import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  test('removes only the leaked .lcov.info.*.tmp files, never the report itself', () => {
    const dir = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}covtmp-`));
    try {
      for (const name of ['.lcov.info.abc123.tmp', '.lcov.info.def456.tmp', 'lcov.info', 'other.tmp']) {
        writeFileSync(join(dir, name), '');
      }
      expect(reapCoverageTmp(dir)).toBe(2);
      expect(readdirSync(dir).sort()).toEqual(['lcov.info', 'other.tmp']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op on a missing coverage dir', () => {
    expect(reapCoverageTmp(join(tmpdir(), `${SCRATCH_PREFIX}does-not-exist-${process.pid}`))).toBe(0);
  });
});
