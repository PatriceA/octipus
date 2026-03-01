import { BaseSkill, createParameterSchema } from '../base-skill';
import type { SkillManifest } from '@/core/types';
import type { AgentContext } from '@/core/types';
import { skillLogger } from '@/utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const EXEC_TIMEOUT = 30000; // 30s

/**
 * Docker skill for managing containers, building images, and viewing logs.
 * All operations require user approval (ASK permission).
 */
export class DockerSkill extends BaseSkill {
  readonly id = 'docker';
  readonly name = 'Docker';
  readonly version = '1.0.0';
  readonly description = 'Manage Docker containers, images, and services';

  getManifest(): SkillManifest {
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

  private async runDocker(cmd: string): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execAsync(`docker ${cmd}`, { timeout: EXEC_TIMEOUT });
      return result;
    } catch (error: any) {
      if (error.stdout || error.stderr) {
        return { stdout: error.stdout || '', stderr: error.stderr || '' };
      }
      throw new Error(`Docker command failed: ${error.message}`);
    }
  }

  private async listContainers(args: Record<string, unknown>): Promise<unknown> {
    const allFlag = args.show_all ? '-a' : '';
    const { stdout } = await this.runDocker(`ps ${allFlag} --format "{{json .}}"`);

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
    const container = args.container as string;
    const { stdout, stderr } = await this.runDocker(`start ${container}`);
    return { container, started: true, output: stdout.trim() || stderr.trim() };
  }

  private async stopContainer(args: Record<string, unknown>): Promise<unknown> {
    const container = args.container as string;
    const timeout = (args.timeout as number) || 10;
    const { stdout, stderr } = await this.runDocker(`stop -t ${timeout} ${container}`);
    return { container, stopped: true, output: stdout.trim() || stderr.trim() };
  }

  private async containerLogs(args: Record<string, unknown>): Promise<unknown> {
    const container = args.container as string;
    const tail = (args.tail as number) || 100;
    const since = args.since as string | undefined;

    let cmd = `logs --tail ${tail}`;
    if (since) cmd += ` --since ${since}`;
    cmd += ` ${container}`;

    const { stdout, stderr } = await this.runDocker(cmd);
    const logs = (stdout + stderr).trim();

    return { container, logs, lineCount: logs.split('\n').length };
  }

  private async buildImage(args: Record<string, unknown>): Promise<unknown> {
    const path = args.path as string;
    const tag = args.tag as string;
    const dockerfile = (args.dockerfile as string) || 'Dockerfile';

    const { stdout, stderr } = await execAsync(
      `docker build -t ${tag} -f ${dockerfile} ${path}`,
      { timeout: 300000 }, // 5 minute timeout for builds
    );

    return { tag, path, output: (stdout + stderr).slice(-5000) };
  }

  private async execCommand(args: Record<string, unknown>): Promise<unknown> {
    const container = args.container as string;
    const command = args.command as string;

    const { stdout, stderr } = await this.runDocker(`exec ${container} ${command}`);
    return { container, command, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

export const dockerSkill = new DockerSkill();
