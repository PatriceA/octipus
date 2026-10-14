import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { findProjectRoot } from './index';

process.env.LOG_LEVEL ??= 'error';

afterEach(() => { vi.useRealTimers(); });

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'octipus-projroot-'));
}

test('a walk from deeper down still finds the project root an earlier walk passed', () => {
  const ws = workspace();
  const proj = join(ws, 'proj');
  mkdirSync(join(proj, 'src', 'deep'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{}');
  writeFileSync(join(proj, 'src', 'deep', 'file.ts'), '');

  expect(findProjectRoot(join(proj, 'src'), ws)).toBe(proj);
  // The first walk passed `src` (no marker of its own): it must not answer
  // "no project" for everything below it.
  expect(findProjectRoot(join(proj, 'src', 'deep', 'file.ts'), ws)).toBe(proj);
  expect(findProjectRoot(join(proj, 'src', 'deep', 'new-file.ts'), ws)).toBe(proj);
});

test('a project created after a lookup is found once the cache entry lapses', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const ws = workspace();
  const repo = join(ws, 'repo');
  mkdirSync(repo);
  expect(findProjectRoot(repo, ws)).toBeNull();

  mkdirSync(join(repo, '.git'));
  vi.setSystemTime(Date.now() + 61_000);
  expect(findProjectRoot(repo, ws)).toBe(repo);
});
