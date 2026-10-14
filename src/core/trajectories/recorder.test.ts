import { describe, expect, test } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryRecord } from './types';
import { writeJsonlLine } from './recorder';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'octipus-traj-write-'));
}

const record = (n: number) => ({ schemaVersion: 1, rootSessionId: `s${n}` }) as unknown as TrajectoryRecord;

describe('writeJsonlLine', () => {
  test('reports the 1-based line each record lands on', () => {
    const root = tmpRoot();
    const lines = [1, 2, 3].map((n) => writeJsonlLine(record(n), root));
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
    const written = readFileSync(lines[0].path, 'utf8').trim().split('\n');
    expect(JSON.parse(written[2]).rootSessionId).toBe('s3');
  });

  test('a line appended by someone else is still counted', () => {
    const root = tmpRoot();
    const first = writeJsonlLine(record(1), root);
    appendFileSync(first.path, '{"other":true}\n');
    expect(writeJsonlLine(record(2), root).line).toBe(3);
  });

  test('a file removed between writes restarts at line 1', () => {
    const root = tmpRoot();
    const first = writeJsonlLine(record(1), root);
    writeJsonlLine(record(2), root);
    unlinkSync(first.path);
    expect(writeJsonlLine(record(3), root).line).toBe(1);
  });
});
