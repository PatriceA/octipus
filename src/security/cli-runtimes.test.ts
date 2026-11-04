import { afterEach, expect, test } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { approvedCliRuntimes, discoverCliRuntimes, inspectCliRuntime } from './cli-runtimes';
import { getConfig } from '@/config';
import { wrapCommand } from './shell-sandbox';
const dirs: string[] = [];
afterEach(() => {
  getConfig().security.cliRuntimes = [];
  getConfig().security.shellSandbox = 'off';
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-cli-test-')); dirs.push(dir);
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'target')); mkdirSync(join(dir, 'workspace'));
  const executable = join(dir, 'target', 'echo'); copyFileSync('/bin/echo', executable); chmodSync(executable, 0o755);
  const link = join(dir, 'bin', 'oc'); symlinkSync(executable, link);
  return { dir, executable, link };
}
test('discovers executable symlinks without executing them, excludes directories and non-executables', () => {
  const { dir, link, executable } = fixture();
  writeFileSync(join(dir, 'bin', 'private'), 'secret', { mode: 0o600 });
  mkdirSync(join(dir, 'bin', 'directory'));
  expect(discoverCliRuntimes(join(dir, 'bin'))).toEqual([{ name: 'oc', path: link, resolvedPath: executable }]);
  expect(() => inspectCliRuntime(dir)).toThrow(/file/);
  expect(() => inspectCliRuntime('relative/oc')).toThrow(/absolute/);
});
test('approval pins a symlink target and requires reapproval when it changes', () => {
  const { link, executable } = fixture();
  getConfig().security.cliRuntimes = [inspectCliRuntime(link)];
  expect(approvedCliRuntimes()[0].resolvedPath).toBe(executable);
  rmSync(link); symlinkSync('/bin/true', link);
  expect(approvedCliRuntimes()).toEqual([]);
});
test.skipIf(!existsSync('/usr/bin/bwrap'))('an approved executable outside the workspace runs through a read-only sandbox alias', () => {
  const { dir, link, executable } = fixture();
  getConfig().security.cliRuntimes = [inspectCliRuntime(link)];
  getConfig().security.shellSandbox = 'required';
  const wrapped = wrapCommand(['/bin/sh', '-c', 'oc runtime-ok; test ! -e "$1"', 'test', join(dir, 'bin')], { workspaceRoot: join(dir, 'workspace') });
  try {
    const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('runtime-ok\n');
    expect(wrapped.argv).toContain(executable);
    expect(wrapped.argv).not.toContain(join(dir, 'target'));
  } finally { wrapped.cleanup(); }
  getConfig().security.cliRuntimes = [];
  const without = wrapCommand(['/bin/sh', '-c', 'command -v oc'], { workspaceRoot: join(dir, 'workspace'), path: '/usr/bin:/bin' });
  try { expect(spawnSync(without.argv[0], without.argv.slice(1)).status).not.toBe(0); }
  finally { without.cleanup(); }
});
