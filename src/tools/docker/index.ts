import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { claimDockerProject } from '@/db/repositories/docker-project-repository';
import { realpath, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join } from 'node:path';
import { WorkspaceFS } from '@/security/workspace-fs';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { resolveComposeBindPaths, validateRawCompose, validateComposeFilesystem, validateComposeConfig } from './compose-policy';
import { spawn } from 'child_process';
import { buildChildEnv } from '@/security/child-env';
import type { AgentContext, ToolManifest } from '@/core/types';
import {
  buildIsolationFlags,
  inspectOwnership,
  isolationActive,
  listFilterFlags,
} from '@/security/docker-isolation';
import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';

const EXEC_TIMEOUT = 30000; // 30s
/**
 * How long the `docker` client gets to act on SIGTERM before it is killed.
 *
 * Long enough for it to pass the signal to an attached container and for that
 * container's own stop to be under way; short enough that a wedged client does
 * not hold the deadline open. Docker's own default stop grace is ten seconds,
 * so anything at or above that would just be waiting on the container twice.
 */
const DOCKER_SIGKILL_GRACE_MS = 5000;

/** Validate that a string argument does not contain shell metacharacters */
function validateArg(value: string, label: string): string {
  if (/[;&|`$(){}!\\\n\r]/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
  return value;
}

/**
 * Docker tool for managing containers, building images, and viewing logs.
 * All operations require user approval (ASK permission).
 */
export class DockerTool extends BaseTool {
  readonly id = 'docker';
  readonly name = 'Docker';
  readonly version = '1.0.0';
  readonly description = 'Manage Docker containers, images, and services';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      // Async, so the boot-time probe of every tool runs these side by side
      // instead of freezing the event loop on each in turn.
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(exec)('docker info', { timeout: 5000, windowsHide: true });
      return { available: true };
    } catch {
      return { available: false, reason: 'Docker not installed or not running' };
    }
  }

  getManifest(): ToolManifest {
    return {
      execution: { kind: 'host', program: 'docker' },
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'compose', description: 'Manage an approved local Compose project in a named repository, including up/down, health, status and logs', defaultLevel: 'ASK', dangerous: true },
        { action: 'list', description: 'List Docker containers and images on the local Docker daemon', defaultLevel: 'ASK' },
        { action: 'start', description: 'Start stopped Docker containers on the local daemon', defaultLevel: 'ASK' },
        { action: 'stop', description: 'Stop running Docker containers — may interrupt active services', defaultLevel: 'ASK', dangerous: true },
        { action: 'logs', description: 'Read stdout/stderr logs from Docker containers', defaultLevel: 'ASK' },
        { action: 'build', description: 'Build Docker images from Dockerfiles in the workspace', defaultLevel: 'ASK' },
        { action: 'exec', description: 'Execute arbitrary commands inside running Docker containers', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [
        { name: 'compose_project', description: 'Host Compose lifecycle: status, up with health wait, logs, down. Local daemon only; remote deployments require approved SSH shell commands.', parameters: { operation: { type: 'string', description: 'status, up, logs or down', required: true }, project: { type: 'string', description: 'Compose project name', required: true }, cwd: { type: 'string', description: 'Approved absolute repository directory', required: true }, build: { type: 'boolean', description: 'Rebuild images during up' }, forceRecreate: { type: 'boolean', description: 'Recreate containers during up' }, services: { type: 'array', description: 'Service names to operate on; omit for the whole project' }, approvedPorts: { type: 'array', description: 'Explicit host ports approved for publication' }, approvedBindPaths: { type: 'array', description: 'Explicit absolute host paths approved for bind mounts' }, file: { type: 'string', description: 'Repository-relative Compose file' }, timeout: { type: 'number', description: 'Total deadline in milliseconds (default 600000)' } }, returns: 'Exit status, stdout/stderr, project health and cleanup status' },
        { name: 'list_containers', description: 'List Docker containers', parameters: { show_all: { type: 'boolean', description: 'Show all' } }, returns: 'Container list' },
        { name: 'start_container', description: 'Start a container', parameters: { container: { type: 'string', description: 'Container name/ID', required: true } }, returns: 'Start result' },
        { name: 'stop_container', description: 'Stop a container', parameters: { container: { type: 'string', description: 'Container name/ID', required: true } }, returns: 'Stop result' },
        { name: 'container_logs', description: 'Get container logs', parameters: { container: { type: 'string', description: 'Container name/ID', required: true }, tail: { type: 'number', description: 'Lines' } }, returns: 'Container logs' },
        { name: 'build_image', description: 'Build a Docker image', parameters: { path: { type: 'string', description: 'Build context', required: true }, tag: { type: 'string', description: 'Image tag', required: true } }, returns: 'Build output' },
        { name: 'exec_command', description: 'Execute a command in a container', parameters: { container: { type: 'string', description: 'Container name/ID', required: true }, command: { type: 'string', description: 'Command', required: true } }, returns: 'Command output' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool('compose_project',
      'Manage an explicitly approved local host Docker Compose project, including existing stacks whose repository matches. Repository-local builds and env files are supported; use up with build:true and forceRecreate:true to rebuild/restart. Does not need a Docker socket inside the shell sandbox. Operations: status, up (waits for health), logs, down (project resources only; preserves volumes). Remote deployments still require SSH. Published host ports require approvedPorts and host bind mounts require approvedBindPaths. Host data is preserved on down. Multi-user Docker isolation currently refuses Compose; use isolated container tools.',
      createParameterSchema({
        operation: { type: 'string', required: true, description: 'status, up, logs or down' },
        project: { type: 'string', required: true, description: 'Explicit Compose project name' },
        cwd: { type: 'string', required: true, description: 'Approved absolute repository directory' },
        file: { type: 'string', description: 'Compose file relative to repository (default compose.yaml)' },
        build: { type: 'boolean', description: 'Rebuild images with up (default false)' },
        forceRecreate: { type: 'boolean', description: 'Recreate containers with up (default false)' },
        services: { type: 'array', items: { type: 'string' }, description: 'Selected service names, or omit for all services; down always covers the whole named project' },
        approvedBindPaths: { type: 'array', items: { type: 'string' }, description: 'Explicit host paths approved for bind mounts; named volumes need no host path grant' },
        approvedPorts: { type: 'array', items: { type: 'integer' }, description: 'Explicit allowed published host port numbers' },
        timeout: { type: 'number', default: 600000, description: 'Total execution deadline in ms, 1000–1800000, default 600000' },
      }), (args, ctx) => this.composeProject(args, ctx), { permissionAction: 'compose', requiresPermission: true });

    this.registerTool(
      'list_containers',
      'List Docker containers. Shows running containers by default, or all containers with show_all=true.',
      createParameterSchema({
        show_all: { type: 'boolean', description: 'Show all containers including stopped (default: false)', required: false },
      }),
      async (args, ctx) => this.listContainers(args, ctx),
      { requiresPermission: true },
    );

    this.registerTool(
      'start_container',
      'Start a stopped Docker container by name or ID.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
      }),
      async (args, ctx) => this.startContainer(args, ctx),
      { requiresPermission: true },
    );

    this.registerTool(
      'stop_container',
      'Stop a running Docker container by name or ID.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
        timeout: { type: 'number', description: 'Timeout in seconds before force kill (default: 10)', required: false },
      }),
      async (args, ctx) => this.stopContainer(args, ctx),
      { requiresPermission: true },
    );

    this.registerTool(
      'container_logs',
      'Get logs from a Docker container.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
        tail: { type: 'number', description: 'Number of lines from the end (default: 100)', required: false },
        since: { type: 'string', description: 'Show logs since timestamp or relative time (e.g., "10m")', required: false },
      }),
      async (args, ctx) => this.containerLogs(args, ctx),
      { requiresPermission: true },
    );

    this.registerTool(
      'build_image',
      'Build a Docker image from a Dockerfile.',
      createParameterSchema({
        path: { type: 'string', description: 'Build context path (directory with Dockerfile)', required: true },
        tag: { type: 'string', description: 'Image tag (e.g., "myapp:latest")', required: true },
        dockerfile: { type: 'string', description: 'Dockerfile path relative to context (default: "Dockerfile")', required: false },
      }),
      async (args, ctx) => this.buildImage(args, ctx),
      { requiresPermission: true },
    );

    this.registerTool(
      'exec_command',
      'Execute a command inside a running Docker container.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
        command: { type: 'string', description: 'Command to execute', required: true },
      }),
      async (args, ctx) => this.execCommand(args, ctx),
      { requiresPermission: true },
    );
  }

  private async runDocker(args: string[], timeout: number = EXEC_TIMEOUT, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      // The args come from the model, and `docker run --env NAME` forwards a
      // variable into a container whose output the model then reads — so the
      // docker CLI must not be holding the harness's secrets in the first
      // place.
      //
      // The deadline is ours rather than node's `timeout` option, for the same
      // reason the shell tool's is: node kills with SIGTERM on its own
      // schedule and the result then says only that the command is gone, with
      // nothing to say a deadline is what ended it.
      const child = spawn('docker', args, { env: buildChildEnv(), ...(cwd ? { cwd } : {}) });
      let timedOut = false;
      let escalation: ReturnType<typeof setTimeout> | null = null;
      const deadline = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        // SIGTERM FIRST, and this one matters more here than in the shell tool.
        // The `docker` CLI is a client: attached to a container, it proxies
        // SIGTERM through so the container stops. It cannot proxy SIGKILL —
        // that kills the client and leaves the container running with nothing
        // holding a handle to it, which is worse than the timeout it replaced.
        // Escalate only if the client itself ignores the request.
        // ponytail: on Windows SIGTERM is TerminateProcess, so nothing is
        // proxied and a timed-out `exec` keeps running in the container. No
        // `docker run` goes through here to `--name`/`docker kill`; killing the
        // whole container for an exec timeout would be worse. Revisit if run lands.
        child.kill('SIGTERM');
        escalation = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, DOCKER_SIGKILL_GRACE_MS);
        escalation.unref?.();
      }, timeout);
      const clearDeadline = (): void => {
        clearTimeout(deadline);
        if (escalation) clearTimeout(escalation);
      };
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });

      child.on('error', (err) => {
        clearDeadline();
        reject(new Error(`Docker command failed: ${err.message}`));
      });

      child.on('close', (exitCode) => {
        clearDeadline();
        // Output comes back on a non-zero exit too — docker writes the useful
        // part to stderr — but a killed command says so, since its stdout is
        // whatever had been flushed rather than an answer.
        if (timedOut) {
          reject(new Error(`Docker command timed out after ${timeout}ms: docker ${args[0] ?? ''}`));
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  }

  private async composeProject(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    if (!ctx) throw new ToolNotExecutedError('docker', 'Compose requires an authenticated agent context');
    if (isolationActive(ctx.userId)) throw new ToolNotExecutedError('docker', 'Compose lifecycle is unavailable under per-user Docker isolation; use isolated container operations. Host Docker may still be available.');
    if (!['status', 'up', 'logs', 'down'].includes(String(args.operation))) throw new ToolNotExecutedError('docker', 'Unsupported Compose operation; use status, up, logs or down');
    if (typeof args.project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(args.project)) throw new ToolNotExecutedError('docker', 'Invalid Compose project name');
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd)) throw new ToolNotExecutedError('docker', 'Compose requires an approved absolute repository path');
    const fs = WorkspaceFS.forAgent(ctx);
    const cwd = await realpath(fs.resolve(args.cwd));
    fs.resolve(cwd);
    const file = await realpath(resolve(cwd, typeof args.file === 'string' ? args.file : 'compose.yaml'));
    const rel = relative(cwd, file);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolNotExecutedError('docker', 'Compose file must be inside the approved repository');
    let rawText: string;
    try { rawText = await validateRawCompose(file, cwd); } catch (error) { throw new ToolNotExecutedError('docker', (error as Error).message); }
    const ports = args.approvedPorts ?? [];
    if (!Array.isArray(ports) || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new ToolNotExecutedError('docker', 'approvedPorts must contain integer host ports from 1 to 65535');
    const bindPaths = args.approvedBindPaths ?? [];
    if (!Array.isArray(bindPaths) || bindPaths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new ToolNotExecutedError('docker', 'approvedBindPaths must contain explicit absolute host paths');
    const timeout = args.timeout ?? 600_000;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000 || timeout > 1_800_000) throw new ToolNotExecutedError('docker', 'Compose timeout must be between 1000 and 1800000 ms');
    for (const flag of ['build', 'forceRecreate']) if (args[flag] !== undefined && typeof args[flag] !== 'boolean') throw new ToolNotExecutedError('docker', `${flag} must be a boolean`);
    const services = args.services ?? [];
    if (!Array.isArray(services) || services.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))) throw new ToolNotExecutedError('docker', 'services must contain explicit Compose service names');
    if (args.operation === 'down' && services.length) throw new ToolNotExecutedError('docker', 'down operates on the whole named project; omit services');
    if (args.operation !== 'up' && (args.build || args.forceRecreate)) throw new ToolNotExecutedError('docker', 'build and forceRecreate apply only to up');
    const deadline = Date.now() + timeout;
    const run = (argv: string[], limit = EXEC_TIMEOUT) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Compose tool deadline expired; inspect project state before retrying');
      return this.runDocker(['--host', 'unix:///var/run/docker.sock', ...argv], Math.min(limit, remaining), cwd);
    };
    const snapshot = await mkdtemp(join(tmpdir(), 'octipus-compose-snapshot-'));
    try {
    const sourceFile = join(snapshot, 'source.yaml');
    await writeFile(sourceFile, rawText, { mode: 0o600 });
    let environmentFile = '/dev/null';
    try {
      const candidate = await realpath(join(cwd, '.env'));
      const envRelative = relative(cwd, candidate);
      if (envRelative.startsWith('..') || isAbsolute(envRelative)) throw new ToolNotExecutedError('docker', 'Compose .env must resolve inside the approved repository');
      if (!(await stat(candidate)).isFile()) throw new ToolNotExecutedError('docker', 'Compose .env must be a regular file');
      environmentFile = candidate;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const base = ['compose', '--env-file', environmentFile, '--project-directory', cwd, '-f', sourceFile, '-p', args.project];
    // Never operate on a same-named stack belonging to another repository.
    const existing = await run(['ps', '-a', '--filter', `label=com.docker.compose.project=${args.project}`, '--format', '{{.ID}}']);
    if (existing.exitCode !== 0) return { ...existing, project: args.project, operation: args.operation, executed: false };
    for (const id of existing.stdout.trim().split(/\s+/).filter(Boolean)) {
      const owner = await run(['inspect', '-f', '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}', id]);
      if (owner.exitCode !== 0 || owner.stdout.trim() !== cwd) throw new ToolNotExecutedError('docker', 'Compose project name belongs to a different repository; choose a distinct approved project');
    }
    const volumes = await run(['volume', 'ls', '--filter', `label=com.docker.compose.project=${args.project}`, '--format', '{{.Name}}']);
    const networks = await run(['network', 'ls', '--filter', `label=com.docker.compose.project=${args.project}`, '--format', '{{.Name}}']);
    if (volumes.exitCode !== 0 || networks.exitCode !== 0) return { project: args.project, operation: args.operation, executed: false, exitCode: volumes.exitCode || networks.exitCode, error: 'Could not verify Compose project resources' };
    const daemon = createHash('sha256').update(JSON.stringify([hostname(), 'unix:///var/run/docker.sock'])).digest('hex');
    const parsed = await run([...base, 'config', '--format', 'json']);
    if (parsed.exitCode !== 0) return { project: args.project, operation: args.operation, exitCode: parsed.exitCode, executed: false, error: 'Compose configuration validation failed; inspect repository configuration without exposing credentials' };
    let config: Record<string, unknown>;
    try { config = JSON.parse(parsed.stdout); const approvedBinds = await resolveComposeBindPaths(config, bindPaths as string[]); validateComposeConfig(config, cwd, ports as number[], approvedBinds); await validateComposeFilesystem(config, cwd); }
    catch (error) { throw new ToolNotExecutedError('docker', error instanceof SyntaxError ? 'Invalid Compose configuration JSON' : (error as Error).message); }
    try { await claimDockerProject(`${daemon}:${args.project}`, cwd, ctx, true, !!(existing.stdout.trim() || volumes.stdout.trim() || networks.stdout.trim()), true); }
    catch (error) { throw new ToolNotExecutedError('docker', (error as Error).message); }
      const snapshotFile = join(snapshot, 'compose.json');
      await writeFile(snapshotFile, JSON.stringify(config).replace(/\$/g, () => '$$'), { mode: 0o600 });
      // The source repository is never reread for lifecycle execution. Bind sources are resolved against explicit host-path consent;
      // skip a second environment interpolation.
      const executionBase = ['compose', '--env-file', '/dev/null', '--project-directory', cwd, '-f', snapshotFile, '-p', args.project];
    const command = args.operation === 'up' ? ['up', '-d', ...(args.build ? ['--build'] : []), ...(args.forceRecreate ? ['--force-recreate'] : []), '--wait', '--wait-timeout', String(Math.max(1, Math.floor(timeout / 1000) - 5))]
      : args.operation === 'down' ? ['down', '--remove-orphans'] : args.operation === 'logs' ? ['logs', '--tail', '200', '--no-color'] : ['ps', '--all', '--format', 'json'];
    const result = await run([...executionBase, ...command, ...services as string[]], timeout);
    const health = args.operation === 'up' || args.operation === 'status'
      ? args.operation === 'status' ? result : await run([...executionBase, 'ps', '--all', '--format', 'json']) : undefined;
    const remaining = args.operation === 'down' && result.exitCode === 0 ? await run(['ps', '-a', '--filter', `label=com.docker.compose.project=${args.project}`, '--format', '{{.ID}}']) : undefined;
    return { ...result, project: args.project, operation: args.operation, executed: true, ...(health ? { health: health.stdout, healthExitCode: health.exitCode } : {}), ...(args.operation === 'down' ? { cleanupSucceeded: result.exitCode === 0 && remaining?.exitCode === 0 && !remaining.stdout.trim(), remainingContainers: remaining?.stdout.trim().split(/\s+/).filter(Boolean) ?? [], volumesPreserved: true } : {}) };
    } finally { await rm(snapshot, { recursive: true, force: true }); }
  }

  /**
   * Phase 3f — guard a targeted operation (start/stop/logs/exec) by
   * verifying the container carries the caller's `octipus.user_id`
   * label. Returns the input container name on success; throws a
   * "container not found" error on miss / wrong-owner so the agent
   * can't enumerate other users' containers by probing.
   *
   * No-op when isolation is off — the existing behavior is preserved.
   */
  private async assertOwnership(container: string, ctx?: AgentContext): Promise<void> {
    const userId = ctx?.userId;
    if (!isolationActive(userId)) return;
    const result = await inspectOwnership(container, userId!);
    if (result !== 'ok') {
      throw new Error(`Container not found: ${container}`);
    }
  }

  private async listContainers(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const dockerArgs = ['ps'];
    if (args.show_all) dockerArgs.push('-a');
    // Phase 3f — when isolation is on, hide containers that don't
    // carry the caller's user label.
    dockerArgs.push(...listFilterFlags(ctx?.userId ?? ''));
    dockerArgs.push('--format', '{{json .}}');

    const { stdout } = await this.runDocker(dockerArgs);

    const containers = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);

    return { containers, count: containers.length };
  }

  private async startContainer(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    await this.assertOwnership(container, ctx);
    const { stdout, stderr } = await this.runDocker(['start', container]);
    return { container, started: true, output: stdout.trim() || stderr.trim() };
  }

  private async stopContainer(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    await this.assertOwnership(container, ctx);
    const timeout = (args.timeout as number) || 10;
    const { stdout, stderr } = await this.runDocker(['stop', '-t', String(timeout), container]);
    return { container, stopped: true, output: stdout.trim() || stderr.trim() };
  }

  private async containerLogs(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    await this.assertOwnership(container, ctx);
    const tail = (args.tail as number) || 100;
    const since = args.since as string | undefined;

    const dockerArgs = ['logs', '--tail', String(tail)];
    if (since) {
      dockerArgs.push('--since', validateArg(since, 'since'));
    }
    dockerArgs.push(container);

    const { stdout, stderr } = await this.runDocker(dockerArgs);
    const logs = (stdout + stderr).trim();

    return { container, logs, lineCount: logs.split('\n').length };
  }

  private async buildImage(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const path = validateArg(args.path as string, 'path');
    const tag = validateArg(args.tag as string, 'tag');
    const dockerfile = validateArg((args.dockerfile as string) || 'Dockerfile', 'dockerfile');

    // Phase 3f — auto-inject the per-user label so any container
    // later run from this image can be filtered by ownership. The
    // image itself doesn't carry a network; that goes on `docker run`.
    const isoFlags = buildIsolationFlags(ctx?.userId ?? '');
    const { stdout, stderr } = await this.runDocker(
      ['build', ...isoFlags, '-t', tag, '-f', dockerfile, path],
      300000, // 5 minute timeout for builds
    );

    return { tag, path, output: (stdout + stderr).slice(-5000) };
  }

  private async execCommand(args: Record<string, unknown>, ctx?: AgentContext): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    await this.assertOwnership(container, ctx);
    const command = args.command as string;

    // Split command into array for safe execution; use sh -c for complex commands
    // but container name is validated and passed as a separate argument
    const dockerArgs = ['exec', container, 'sh', '-c', command];
    const { stdout, stderr } = await this.runDocker(dockerArgs);
    return { container, command, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

export const dockerTool = new DockerTool();
