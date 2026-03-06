import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import type { AgentContext } from '@/core/types';
import { toolLogger } from '@/utils/logger';
import { spawn } from 'child_process';

const EXEC_TIMEOUT = 30000; // 30s

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

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'list', description: 'List containers', defaultLevel: 'ASK' },
        { action: 'start', description: 'Start containers', defaultLevel: 'ASK' },
        { action: 'stop', description: 'Stop containers', defaultLevel: 'ASK', dangerous: true },
        { action: 'logs', description: 'View container logs', defaultLevel: 'ASK' },
        { action: 'build', description: 'Build Docker images', defaultLevel: 'ASK' },
        { action: 'exec', description: 'Execute commands in containers', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [
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
    this.registerTool(
      'list_containers',
      'List Docker containers. Shows running containers by default, or all containers with show_all=true.',
      createParameterSchema({
        show_all: { type: 'boolean', description: 'Show all containers including stopped (default: false)', required: false },
      }),
      async (args) => this.listContainers(args),
      { requiresPermission: true },
    );

    this.registerTool(
      'start_container',
      'Start a stopped Docker container by name or ID.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
      }),
      async (args) => this.startContainer(args),
      { requiresPermission: true },
    );

    this.registerTool(
      'stop_container',
      'Stop a running Docker container by name or ID.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
        timeout: { type: 'number', description: 'Timeout in seconds before force kill (default: 10)', required: false },
      }),
      async (args) => this.stopContainer(args),
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
      async (args) => this.containerLogs(args),
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
      async (args) => this.buildImage(args),
      { requiresPermission: true },
    );

    this.registerTool(
      'exec_command',
      'Execute a command inside a running Docker container.',
      createParameterSchema({
        container: { type: 'string', description: 'Container name or ID', required: true },
        command: { type: 'string', description: 'Command to execute', required: true },
      }),
      async (args) => this.execCommand(args),
      { requiresPermission: true },
    );
  }

  private async runDocker(args: string[], timeout: number = EXEC_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { timeout });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });

      child.on('error', (err) => {
        reject(new Error(`Docker command failed: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          // Match previous behavior: return output even on non-zero exit
          resolve({ stdout, stderr });
        }
      });
    });
  }

  private async listContainers(args: Record<string, unknown>): Promise<unknown> {
    const dockerArgs = ['ps'];
    if (args.show_all) dockerArgs.push('-a');
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

  private async startContainer(args: Record<string, unknown>): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    const { stdout, stderr } = await this.runDocker(['start', container]);
    return { container, started: true, output: stdout.trim() || stderr.trim() };
  }

  private async stopContainer(args: Record<string, unknown>): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    const timeout = (args.timeout as number) || 10;
    const { stdout, stderr } = await this.runDocker(['stop', '-t', String(timeout), container]);
    return { container, stopped: true, output: stdout.trim() || stderr.trim() };
  }

  private async containerLogs(args: Record<string, unknown>): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
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

  private async buildImage(args: Record<string, unknown>): Promise<unknown> {
    const path = validateArg(args.path as string, 'path');
    const tag = validateArg(args.tag as string, 'tag');
    const dockerfile = validateArg((args.dockerfile as string) || 'Dockerfile', 'dockerfile');

    const { stdout, stderr } = await this.runDocker(
      ['build', '-t', tag, '-f', dockerfile, path],
      300000, // 5 minute timeout for builds
    );

    return { tag, path, output: (stdout + stderr).slice(-5000) };
  }

  private async execCommand(args: Record<string, unknown>): Promise<unknown> {
    const container = validateArg(args.container as string, 'container');
    const command = args.command as string;

    // Split command into array for safe execution; use sh -c for complex commands
    // but container name is validated and passed as a separate argument
    const dockerArgs = ['exec', container, 'sh', '-c', command];
    const { stdout, stderr } = await this.runDocker(dockerArgs);
    return { container, command, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

export const dockerTool = new DockerTool();
