import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DockerTool } from './index';
import type { AgentContext } from '@/core/types';
vi.mock('@/db/repositories/docker-project-repository', () => ({ claimDockerProject: vi.fn() }));
vi.mock('@/security/workspace-fs', () => ({ WorkspaceFS: { forAgent: () => ({ resolve: (path: string) => path }) } }));
vi.mock('@/security/docker-isolation', () => ({ isolationActive: vi.fn(() => false), buildIsolationFlags: () => [], listFilterFlags: () => [], inspectOwnership: vi.fn() }));
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'octipus-compose-')); dirs.push(cwd); writeFileSync(join(cwd, 'compose.yaml'), 'services: {}');
  const tool = new DockerTool() as unknown as { runDocker(args: string[], timeout?: number, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }>; composeProject(args: Record<string, unknown>, ctx: AgentContext): Promise<Record<string, unknown>> };
  const calls: string[][] = [];
  const run = vi.spyOn(tool, 'runDocker').mockImplementation(async args => { calls.push(args); return { stdout: args.includes('config') ? JSON.stringify({ name: 'demo', services: { web: { image: 'nginx', ports: [{ published: '4300' }] } } }) : '', stderr: '', exitCode: 0 }; });
  return { cwd, tool, calls, run, context: { userId: 'user' } as AgentContext };
}
test('starts a named project with health wait and preserves volumes during scoped cleanup', async () => {
  const { cwd, tool, calls, context } = fixture();
  expect(await tool.composeProject({ cwd, project: 'demo', operation: 'up', approvedPorts: [4300] }, context)).toMatchObject({ exitCode: 0, executed: true, healthExitCode: 0 });
  expect(calls.some(args => args.includes('up') && args.includes('--wait') && args.includes(cwd) && args.includes('unix:///var/run/docker.sock'))).toBe(true);
  expect(await tool.composeProject({ cwd, project: 'demo', operation: 'down', approvedPorts: [4300] }, context)).toMatchObject({ cleanupSucceeded: true, volumesPreserved: true });
  expect(calls.some(args => args.includes('down') && args.includes('--remove-orphans') && !args.includes('--volumes'))).toBe(true);
});
test('a process failure has an exit code and never claims successful cleanup', async () => {
  const { cwd, tool, run, context } = fixture();
  run.mockImplementation(async args => ({ stdout: args.includes('config') ? '{"name":"demo","services":{}}' : '', stderr: 'daemon error', exitCode: args.includes('down') ? 1 : 0 }));
  expect(await tool.composeProject({ cwd, project: 'demo', operation: 'down' }, context)).toMatchObject({ exitCode: 1, cleanupSucceeded: false });
});
test('refuses another repository project before lifecycle execution', async () => {
  const { cwd, tool, run, calls, context } = fixture();
  run.mockImplementation(async args => ({ stdout: args[2] === 'ps' ? 'abc' : '/different/repo', stderr: '', exitCode: 0 }));
  await expect(tool.composeProject({ cwd, project: 'demo', operation: 'down' }, context)).rejects.toThrow('different repository');
  expect(calls.some(args => args.includes('down'))).toBe(false);
});

test('lifecycle executes captured normalized configuration even if source is replaced', async () => {
  const { readFileSync } = await import('node:fs');
  const { cwd, tool, run, context } = fixture();
  let executedSnapshot = false;
  run.mockImplementation(async args => {
    if (args.includes('config')) {
      const input = args[args.indexOf('-f') + 1];
      expect(input).not.toBe(join(cwd, 'compose.yaml'));
      writeFileSync(join(cwd, 'compose.yaml'), 'services:\n  evil:\n    privileged: true');
      return { stdout: '{"name":"demo","services":{"web":{"image":"nginx"}}}', stderr: '', exitCode: 0 };
    }
    if (args.includes('up')) {
      const snapshot = JSON.parse(readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      expect(snapshot.services).toHaveProperty('web'); expect(snapshot.services).not.toHaveProperty('evil'); executedSnapshot = true;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await tool.composeProject({ cwd, project: 'demo', operation: 'up' }, context);
  expect(executedSnapshot).toBe(true);
});

test('an explicitly approved host bind can lie outside the repository', async () => {
  const { cwd, tool, run, context } = fixture();
  const host = mkdtempSync(join(tmpdir(), 'octipus-compose-host-data-')); dirs.push(host);
  run.mockImplementation(async args => ({ stdout: args.includes('config') ? JSON.stringify({ name: 'demo', services: { web: { image: 'nginx', volumes: [{ type: 'bind', source: host, target: '/data' }] } } }) : '', stderr: '', exitCode: 0 }));
  expect(await tool.composeProject({ cwd, project: 'demo', operation: 'up', approvedBindPaths: [host] }, context)).toMatchObject({ executed: true, exitCode: 0 });
});

test('approved existing project can be claimed for status and cleanup after repository labels match', async () => {
  const { claimDockerProject } = await import('@/db/repositories/docker-project-repository');
  const { cwd, tool, run, context } = fixture();
  run.mockImplementation(async args => ({ stdout: args.includes('inspect') ? cwd : args[2] === 'ps' ? 'existing-container' : args.includes('config') ? '{"name":"demo","services":{}}' : '', stderr: '', exitCode: 0 }));
  expect(await tool.composeProject({ cwd, project: 'demo', operation: 'status' }, context)).toMatchObject({ executed: true });
  expect(claimDockerProject).toHaveBeenLastCalledWith(expect.stringContaining(':demo'), cwd, context, true, true, true);
});

test('rebuild and recreate selected services using repository env configuration without returning its contents', async () => {
  const { readFileSync } = await import('node:fs');
  const { cwd, tool, run, calls, context } = fixture();
  writeFileSync(join(cwd, 'compose.yaml'), 'services:\n  app:\n    build: .\n    env_file: .env');
  writeFileSync(join(cwd, 'Dockerfile'), 'FROM scratch');
  writeFileSync(join(cwd, '.env'), 'MCP_STORE_KEY=canary-no-output');
  let consumedEnvironment = false;
  run.mockImplementation(async args => {
    calls.push(args);
    if (args.includes('config')) {
      consumedEnvironment = args[args.indexOf('--env-file') + 1] === join(cwd, '.env');
      return { stdout: JSON.stringify({ name: 'demo', services: { app: { build: { context: cwd }, environment: { MCP_STORE_KEY: 'canary-no-output' } } } }), stderr: '', exitCode: 0 };
    }
    if (args.includes('up')) {
      const snapshot = JSON.parse(readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
      expect(snapshot.services.app.environment.MCP_STORE_KEY).toBe('canary-no-output');
      expect(args[args.indexOf('--env-file') + 1]).toBe('/dev/null');
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const result = await tool.composeProject({ cwd, project: 'demo', operation: 'up', build: true, forceRecreate: true, services: ['app'] }, context);
  expect(consumedEnvironment).toBe(true);
  expect(calls.find(args => args.includes('up'))).toEqual(expect.arrayContaining(['--build', '--force-recreate', 'app']));
  expect(JSON.stringify(result)).not.toContain('canary-no-output');
});

test('a build context outside the repository and a service-scoped down never reach execution', async () => {
  const { cwd, tool, calls, context } = fixture();
  await expect(tool.composeProject({ cwd, project: 'demo', operation: 'down', services: ['app'] }, context)).rejects.toThrow('whole named project');
  writeFileSync(join(cwd, 'compose.yaml'), 'services:\n  app:\n    build: /outside');
  await expect(tool.composeProject({ cwd, project: 'demo', operation: 'up', build: true }, context)).rejects.toThrow('inside the approved repository');
  expect(calls).toHaveLength(0);
});
