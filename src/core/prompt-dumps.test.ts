import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sweepStaleFiles } from './cli-adapters';
import { writePromptDump } from './prompt-dumps';

process.env.LOG_LEVEL ??= 'error';

let home: string;
const originalHome = process.env.HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octipus-dumps-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = originalHome;
  vi.useRealTimers();
});

test('a dump is written owner-only without blocking the caller', async () => {
  writePromptDump('one.md', '# Agent a1', { agentId: 'a1' });
  const path = join(home, '.octipus', 'prompts', 'one.md');
  await vi.waitFor(() => expect(existsSync(path)).toBe(true));
  expect(readFileSync(path, 'utf-8')).toBe('# Agent a1');
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('a directory is swept at most once an hour', () => {
  const dir = join(home, 'sweep');
  mkdirSync(dir);
  const old = (name: string) => {
    const file = join(dir, name);
    writeFileSync(file, 'x');
    const then = (Date.now() - 10 * 24 * 3600_000) / 1000;
    utimesSync(file, then, then);
    return file;
  };
  const first = old('a.md');
  sweepStaleFiles(dir, '', 7 * 24 * 3600_000);
  expect(existsSync(first)).toBe(false);

  const second = old('b.md');
  sweepStaleFiles(dir, '', 7 * 24 * 3600_000);
  expect(existsSync(second)).toBe(true);

  vi.useFakeTimers({ now: Date.now() + 3600_000 + 1, toFake: ['Date'] });
  sweepStaleFiles(dir, '', 7 * 24 * 3600_000);
  expect(existsSync(second)).toBe(false);
});
