import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { spaceRunOptions } from './index';
import { wrapCommand, detectRunner } from '@/security/shell-sandbox';
import { LocalShellOperations } from './local-operations';
import { getConfig } from '@/config';
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn((await original<typeof import('node:os')>()).homedir) }));

test('personal shells mount Git configuration read-only; space shells keep their own identity (#65)', () => {
  expect(spaceRunOptions(undefined, null).extraReadOnly).toEqual([join(homedir(), '.gitconfig'), join(homedir(), '.config/git/config')]);
  const shared = spaceRunOptions({}, { dir: '/space-home', env: { HOME: '/space-home' }, gitArgs: [], dispose() {} });
  expect(shared.extraReadOnly).toBeUndefined();
  expect(shared.env?.HOME).toBe('/space-home');
});

test.skipIf(detectRunner()?.runner !== 'bwrap')('a sandboxed gate can commit using personal Git identity and inherits its required gate env (#65)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octi-git-identity-'));
  const previous = getConfig().security.shellSandbox;
  const priorGateEnv = process.env.YAEMP_TEST_ADMIN_URL;
  try {
    vi.mocked(homedir).mockReturnValue(dir);
    getConfig().security.shellSandbox = 'required';
    const project = join(dir, 'project'); mkdirSync(project);
    writeFileSync(join(dir, '.gitconfig'), '[user]\n  name = Fixture Author\n  email = fixture@example.test\n');
    process.env.YAEMP_TEST_ADMIN_URL = 'fixture-value';
    writeFileSync(join(project, 'check.cjs'), `const {execFileSync}=require('node:child_process'); const assert=require('node:assert/strict'); assert.equal(process.env.YAEMP_TEST_ADMIN_URL,'fixture-value'); execFileSync('git',['init','-q']); execFileSync('git',['commit','--allow-empty','-m','fixture']); assert.match(execFileSync('git',['log','-1','--format=%an <%ae>'],{encoding:'utf8'}),/Fixture Author <fixture@example.test>/); console.log('passed');`);
    const options = spaceRunOptions({ HOME: dir, XDG_CONFIG_HOME: join(dir, '.config') }, null);
    const wrapped = wrapCommand(['git', 'version'], { workspaceRoot: project, extraReadOnly: options.extraReadOnly });
    try { expect(wrapped.argv).toContain('--ro-bind-try'); } finally { wrapped.cleanup(); }
    const result = await new LocalShellOperations().exec('node check.cjs', project, { ...options, timeout: 5000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('passed');
  } finally {
    if (priorGateEnv === undefined) delete process.env.YAEMP_TEST_ADMIN_URL; else process.env.YAEMP_TEST_ADMIN_URL = priorGateEnv;
    getConfig().security.shellSandbox = previous; vi.mocked(homedir).mockRestore(); rmSync(dir, { recursive: true, force: true });
  }
});
