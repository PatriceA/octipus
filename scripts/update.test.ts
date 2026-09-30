import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'octipus-update-test-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync('scripts/update.mjs', join(root, 'scripts/update.mjs'));
  writeFileSync(join(root, 'package.json'), '{"name":"octipus","private":true}');
  const run = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/update.mjs'), ...args], { encoding: 'utf8' });
  return { root, run };
}

test('preview keeps the current branch and dirty source checkout untouched; real update refuses it', () => {
  const { root, run } = installation();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
  git('remote', 'add', 'origin', 'https://example.invalid/octipus.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('branch', '--set-upstream-to=origin/main');
  writeFileSync(join(root, 'local.txt'), 'keep');
  const before = git('status', '--porcelain');
  const preview = run('--dry-run');
  expect(preview.status).toBe(0);
  expect(preview.stdout).toContain('git pull --ff-only');
  expect(preview.stdout).toContain('Preview only');
  expect(git('status', '--porcelain')).toBe(before);
  const update = run();
  expect(update.status).toBe(1);
  expect(update.stderr).toContain('Checkout has local changes');
});

test('does not guess a registry package for a private source snapshot', () => {
  const { run } = installation();
  const result = run('--dry-run');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('original installer');
});
