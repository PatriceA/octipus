import { spawn } from 'node:child_process';
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentContext, ToolManifest } from '@/core/types';
import type { ToolHandler } from '@/core/agent-base';
import { getExecutionSignal } from '@/core/execution-scope';
import { sessionRepository } from '@/db/repositories/session-repository';
import { WorkspaceFS } from '@/security/workspace-fs';
import { worktreeCwdOverride } from '@/core/swarm/worktree';
import { killProcessTree, whichSync } from '@/utils/proc';
import { BaseTool } from './base-tool';

export const TEST_IMAGES = ['python:3.12-slim', 'python:3.13-slim', 'node:22-bookworm-slim', 'node:24-bookworm-slim'] as const;
const parameters = { type: 'object', additionalProperties: false, properties: {
  image: { type: 'string', enum: TEST_IMAGES, description: 'Official runtime image; pulled if absent.' },
  command: { type: 'array', items: { type: 'string' }, description: 'Container argv, e.g. ["sh", "-c", "pip install -r tests/requirements.txt && pytest -p no:cacheprovider"]. No host shell.' },
  timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 300 seconds; maximum 600.' },
}, required: ['image', 'command'] };

export function testContainerArgs(name: string, root: string, image: string, command: string[], seconds: number): string[] {
  if (!TEST_IMAGES.includes(image as typeof TEST_IMAGES[number])) throw new Error('Unsupported test runtime image.');
  if (!Array.isArray(command) || !command.length || command.length > 100
    || command.some(value => typeof value !== 'string' || value.includes('\0'))
    || command.join('').length > 32768 || !command[0] || command[0].startsWith('-')) throw new Error('Expected a bounded, nonempty command argv.');
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('Timeout must be 1–600 seconds.');
  if (/[\x00-\x1f,]/.test(root)) throw new Error('Workspace path contains unsupported mount characters.');
  return ['run', '--rm', '--name', name, '--label', 'octipus.test-run=true',
    '--pull=missing', '--init', '--stop-timeout=2', '--cpus=2', '--memory=4g', '--memory-swap=4g', '--pids-limit=256',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', `--user=${process.getuid?.() || 65534}:${process.getgid?.() || 65534}`,
    '--network=bridge', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--mount', `type=bind,src=${root},dst=/workspace,readonly,bind-recursive=disabled`, '--workdir=/workspace',
    '--env=HOME=/tmp', '--env=PIP_TARGET=/tmp/python-packages', '--env=PYTHONPATH=/tmp/python-packages',
    '--env=PYTHONDONTWRITEBYTECODE=1', '--env=COVERAGE_FILE=/tmp/.coverage',
    '--env=npm_config_cache=/tmp/npm-cache',
    '--env=PATH=/tmp/python-packages/bin:/usr/local/bin:/usr/bin:/bin',
    // Daemon-side deadline survives the Octipus process disappearing.
    '--entrypoint=/usr/bin/timeout', image, '--signal=TERM', '--kill-after=5', `${seconds}s`, ...command];
}

type ClientResult = { exitCode: number | null; signal: string | null; stdout: string; stderr: string; interrupted: boolean };
function dockerClient(binary: string, args: string[], config: string, timeout: number, signal?: AbortSignal): Promise<ClientResult> {
  if (signal?.aborted) return Promise.reject(new Error('Test container cancelled before launch.'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--host=unix:///var/run/docker.sock', '--config', config, ...args], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: config }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let interrupted = false;
    const stop = () => { interrupted = true; killProcessTree(child.pid, child); };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (exitCode, exitSignal) => { cleanup(); resolve({ exitCode, signal: exitSignal, stdout, stderr, interrupted }); });
  });
}

let active = 0;
export async function runTestContainer(args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
  if (!['qa', 'review'].includes(context.role)) throw new Error('Test containers are available only to QA and review roles.');
  if (Object.keys(args).some(key => !['image', 'command', 'timeout_seconds'].includes(key))) throw new Error('Unsupported test-container option.');
  const session = await sessionRepository.findById(context.sessionId);
  if (!session || session.userId !== context.userId) throw new Error('Session not found.');
  if (session.context?.planMode) throw new Error('Test containers are unavailable in plan mode.');
  if (process.platform !== 'linux') throw new Error('Test containers currently require Linux and a local Docker daemon.');
  const root = await realpath(worktreeCwdOverride(context.metadata) ?? WorkspaceFS.forSession(session).root);
  const seconds = args.timeout_seconds === undefined ? 300 : args.timeout_seconds as number;
  const name = `octipus-test-${randomUUID()}`;
  const command = testContainerArgs(name, root, args.image as string, args.command as string[], seconds);
  const binary = whichSync('docker', { PATH: '/usr/local/bin:/usr/bin:/bin' });
  if (!binary) throw new Error('Docker is not installed.');
  const signal = getExecutionSignal(context);
  if (signal?.aborted) throw new Error('Test container cancelled before launch.');
  if (active >= 2) throw new Error('Two test containers are already active; wait for one to finish.');
  active++;
  let config: string | undefined;
  let result: ClientResult | undefined;
  let cleanupError: string | undefined;
  try {
    config = await mkdtemp(join(tmpdir(), 'octipus-test-docker-'));
    const running = await dockerClient(binary, ['ps', '--filter=label=octipus.test-run=true', '--format={{.ID}}'], config, 10000, signal);
    if (running.exitCode !== 0) throw new Error(`Cannot check active test containers: ${running.stderr}`);
    // Count daemon-side survivors too, including containers from a prior backend.
    if (running.stdout.trim().split('\n').filter(Boolean).length + active > 2) throw new Error('Test-container capacity is occupied; wait for existing runs to finish.');
    try { result = await dockerClient(binary, command, config, (seconds + 30) * 1000, signal); }
    finally {
      // Never act on a caller-supplied name or an existing service container.
      try {
        const cleanup = await dockerClient(binary, ['rm', '--force', name], config, 10000);
        if (cleanup.exitCode !== 0 && !cleanup.stderr.includes('No such container')) cleanupError = cleanup.stderr || 'Container cleanup timed out.';
      } catch (error) { cleanupError = (error as Error).message; }
    }
    return { ...result, container: name, timedOut: result.exitCode === 124 || (result.interrupted && !signal?.aborted),
      aborted: signal?.aborted ?? false, ...(cleanupError ? { cleanupError } : {}),
      limits: { memoryMiB: 4096, cpus: 2, processes: 256, temporaryMiB: 1024, timeoutSeconds: seconds } };
  } finally {
    if (cleanupError) setTimeout(() => { active--; }, (seconds + 30) * 1000).unref();
    else active--;
    if (config) await rm(config, { recursive: true, force: true });
  }
}

class TestContainerTool extends BaseTool {
  readonly id = 'test_container';
  readonly name = 'Disposable QA container';
  readonly version = '1.0.0';
  readonly description = 'Run QA/review tests in a resource-limited disposable container with a read-only project mount.';
  getManifest(): ToolManifest {
    return { id: this.id, name: this.name, version: this.version, description: this.description,
      permissions: [{ action: 'run', defaultLevel: 'ALLOW', description: this.description }], tools: [] };
  }
  protected async registerTools(): Promise<void> {
    this.registerTool('run', this.description, parameters, runTestContainer, { permissionAction: 'run', injectSecrets: false });
  }
}
let instance: Promise<TestContainerTool> | undefined;
export function buildTestContainerHandlers(): ToolHandler[] {
  return [{ name: 'run_test_container', parameters,
    description: 'QA/review only: run tests without general Docker permission. Repository/worktree is read-only at /workspace; /tmp is writable (1 GiB). Network enabled for dependencies. pip installs into /tmp automatically; use pytest -p no:cacheprovider. For writable build trees copy needed files into /tmp first. No injected host credentials, caller-selected mounts, ports, or Docker flags accepted. Limits: 4 GiB RAM, 2 CPUs, 256 processes, up to 10 minutes, two concurrent runs. Check exitCode, stderr and cleanupError; nonzero is failure. Do not repeat unchanged commands after memory/time limits.',
    execute: async (args, context) => {
      instance ??= (async () => { const tool = new TestContainerTool(); await tool.initialize(); return tool; })();
      return (await instance).getTool('run')!.execute(args, context);
    } }];
}
