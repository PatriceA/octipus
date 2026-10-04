import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentContext } from '@/core/types';
import { withExecutionSignal } from '@/core/execution-scope';
import { testContainerArgs, runTestContainer, buildTestContainerHandlers } from './test-container';
const fixture = vi.hoisted(() => ({ root: '', owner: 'u', planMode: false }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => ({
  userId: fixture.owner, context: { devMode: true, projectPath: fixture.root, planMode: fixture.planMode },
}) } }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: async () => ({ level: 'DENY', reason: 'operator disabled' }) }) }));
const context = { id: 'a', userId: 'u', sessionId: 's', role: 'qa', status: 'running', metadata: {} } as AgentContext;
const args = { image: 'python:3.12-slim', command: ['python', '--version'] };
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'octipus-container-test-'));
  fixture.owner = 'u'; fixture.planMode = false;
});
afterEach(() => { rmSync(fixture.root, { force: true, recursive: true }); });

describe('disposable test container boundaries', () => {
  it('pins resources, mount isolation, non-root user and daemon-side deadline', () => {
    const argv = testContainerArgs('test', '/project with spaces', args.image, ['sh', '-c', 'pip install pytest && pytest'], 90);
    for (const flag of ['--rm', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=2', '--memory=4g', '--memory-swap=4g', '--pids-limit=256', '--network=bridge']) expect(argv).toContain(flag);
    expect(argv).toContain('type=bind,src=/project with spaces,dst=/workspace,readonly,bind-recursive=disabled');
    expect(argv).toContain('/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777');
    expect(argv).toContain(`--user=${process.getuid?.() || 65534}:${process.getgid?.() || 65534}`);
    expect(argv.slice(-6)).toEqual(['--signal=TERM', '--kill-after=5', '90s', 'sh', '-c', 'pip install pytest && pytest']);
    expect(argv).not.toContain('--privileged');
  });
  it('rejects arbitrary images, options, command injection into Docker flags, and invalid deadlines', async () => {
    expect(() => testContainerArgs('n', fixture.root, 'attacker/image', ['true'], 1)).toThrow();
    expect(() => testContainerArgs('n', fixture.root, args.image, ['--privileged'], 1)).toThrow();
    expect(() => testContainerArgs('n', '/project,readonly=false', args.image, ['true'], 1)).toThrow();
    for (const seconds of [0, 601, NaN, 1.5]) expect(() => testContainerArgs('n', fixture.root, args.image, ['true'], seconds)).toThrow();
    await expect(runTestContainer({ ...args, privileged: true }, context)).rejects.toThrow('Unsupported');
    await expect(runTestContainer(args, { ...context, role: 'research' })).rejects.toThrow('only to QA');
    fixture.owner = 'other'; await expect(runTestContainer(args, context)).rejects.toThrow('Session not found');
    fixture.owner = 'u'; fixture.planMode = true; await expect(runTestContainer(args, context)).rejects.toThrow('plan mode');
  });
  it('keeps explicit operator DENY rules effective despite default unattended access', async () => {
    await expect(buildTestContainerHandlers()[0].execute(args, context)).rejects.toThrow('Permission denied');
  });
  it('does not launch an already cancelled run', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(withExecutionSignal(context, controller.signal, () => runTestContainer(args, context))).rejects.toThrow('cancelled');
  });
});

describe.skipIf(process.env.OCTIPUS_TEST_DOCKER !== '1')('real local Docker lifecycle', () => {
  it.each(['qa', 'review'] as const)('%s reads the repo, enforces isolation and limits, and removes the container', async role => {
    writeFileSync(join(fixture.root, 'input.txt'), 'fixture');
    const command = ['python', '-c', `import os,pathlib,json
print(pathlib.Path('/workspace/input.txt').read_text())
try:
 pathlib.Path('/workspace/forbidden').write_text('bad')
 raise Exception('workspace unexpectedly writable')
except PermissionError: pass
except OSError as e:
 assert e.errno == 30, e
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('${fixture.root}').exists()
assert os.getuid() != 0
print(pathlib.Path('/sys/fs/cgroup/memory.max').read_text().strip())
print(pathlib.Path('/sys/fs/cgroup/pids.max').read_text().strip())
print(pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().strip())
pathlib.Path('/tmp/ok').write_text('ok')`];
    const result = await runTestContainer({ ...args, command, timeout_seconds: 20 }, { ...context, role }) as any;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('fixture'); expect(result.stdout).toContain('4294967296');
    expect(result.stdout).toContain('256'); expect(result.stdout).toContain('200000 100000');
    expect(existsSync(join(fixture.root, 'forbidden'))).toBe(false);
    expect(result.cleanupError).toBeUndefined();
    expect(() => execFileSync('docker', ['inspect', result.container], { stdio: 'pipe' })).toThrow();
  }, 30000);
  it('installs test dependencies and runs pytest without writing into the repository', async () => {
    writeFileSync(join(fixture.root, 'test_smoke.py'), 'def test_smoke():\n    assert 2 + 2 == 4\n');
    const result = await runTestContainer({ ...args, command: ['sh', '-c', 'pip install --quiet pytest && pytest -p no:cacheprovider'], timeout_seconds: 90 }, context) as any;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 passed');
    expect(existsSync(join(fixture.root, '__pycache__'))).toBe(false);
    expect(existsSync(join(fixture.root, '.pytest_cache'))).toBe(false);
  }, 100000);
  it('refuses excess concurrent runs instead of accumulating containers', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => runTestContainer({ ...args, command: ['sleep', '3'], timeout_seconds: 10 }, context)));
    expect(results.filter(result => result.status === 'fulfilled').length).toBeLessThanOrEqual(2);
    expect(results.some(result => result.status === 'rejected' && /active|capacity/.test(String(result.reason)))).toBe(true);
  }, 20000);
  it('reports a failing test and removes the container', async () => {
    const result = await runTestContainer({ ...args, command: ['python', '-c', 'raise SystemExit(7)'], timeout_seconds: 20 }, context) as any;
    expect(result.exitCode).toBe(7); expect(result.cleanupError).toBeUndefined();
  }, 30000);
  it('kills a timed-out test and removes the container', async () => {
    const result = await runTestContainer({ ...args, command: ['sleep', '60'], timeout_seconds: 1 }, context) as any;
    expect(result.exitCode).toBe(124); expect(result.timedOut).toBe(true);
    expect(() => execFileSync('docker', ['inspect', result.container], { stdio: 'pipe' })).toThrow();
  }, 10000);
  it('cancels a running test and removes the container', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const result = await withExecutionSignal(context, controller.signal, () => runTestContainer({ ...args, command: ['sleep', '60'] }, context)) as any;
      expect(result.aborted).toBe(true); expect(result.cleanupError).toBeUndefined();
      expect(() => execFileSync('docker', ['inspect', result.container], { stdio: 'pipe' })).toThrow();
    } finally { clearTimeout(timer); }
  }, 15000);
});
