import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { gitContextSection } from './worker-spawner';

process.env.LOG_LEVEL ??= 'error';

test('a repo with changes gets its short status and diff stat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-gitctx-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(dir, 'tracked.txt'), 'a\n');
  git('add', 'tracked.txt');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
  writeFileSync(join(dir, 'tracked.txt'), 'a\nb\n');
  writeFileSync(join(dir, 'new.txt'), 'x');

  const section = await gitContextSection(dir);
  expect(section).toContain('--- Git Status ---');
  expect(section).toContain('?? new.txt');
  expect(section).toContain('M tracked.txt');
  expect(section).toContain('Diff summary:');
});

test('outside a repo there is no section, and no throw', async () => {
  expect(await gitContextSection(mkdtempSync(join(tmpdir(), 'octipus-nogit-')))).toBe('');
});
