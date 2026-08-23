import { describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressTrajectoryForDate, trajectoryFilePathForDate } from './recorder';

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'octipus-traj-compress-'));
  mkdirSync(join(root, 'trajectories'), { recursive: true });
  return root;
}

const DATE = new Date('2026-07-10T00:00:00Z');

describe('compressTrajectoryForDate', () => {
  test("no source file → 'no-file' (no-op)", () => {
    expect(compressTrajectoryForDate(DATE, tmpRoot())).toBe('no-file');
  });

  test('a source file is gzipped and the source removed', () => {
    const root = tmpRoot();
    const path = trajectoryFilePathForDate(DATE, root);
    writeFileSync(path, '{"a":1}\n{"b":2}\n');

    expect(compressTrajectoryForDate(DATE, root)).toBe('compressed');
    expect(existsSync(path)).toBe(false); // source removed
    expect(existsSync(`${path}.gz`)).toBe(true);
    expect(gunzipSync(readFileSync(`${path}.gz`)).toString('utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  test("a leftover source next to an existing .gz → 'already-compressed', source dropped", () => {
    const root = tmpRoot();
    const path = trajectoryFilePathForDate(DATE, root);
    writeFileSync(`${path}.gz`, 'preexisting');
    writeFileSync(path, 'leftover');

    expect(compressTrajectoryForDate(DATE, root)).toBe('already-compressed');
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.gz`, 'utf8')).toBe('preexisting'); // not overwritten
  });
});
