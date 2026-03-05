import { spawn } from 'child_process';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Dangerous commands that should never be executed
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/random',
  'chmod -R 777 /',
  'chmod 777 /',
];

// Commands that require elevated permissions
const ELEVATED_COMMANDS = [
  'sudo',
  'su',
  'chown',
  'chmod',
  'systemctl',
  'service',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
];

export class ShellTool extends BaseTool {
  readonly id = 'shell';
  readonly name = 'Shell';
  readonly version = '1.0.0';
  readonly description = 'Execute shell commands in a sandboxed environment';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'execute', description: 'Execute shell commands', defaultLevel: 'ASK' },
        { action: 'execute_elevated', description: 'Execute elevated commands', defaultLevel: 'DENY', dangerous: true },
      ],
      tools: [
        {
          name: 'run',
          description: 'Execute a shell command',
          parameters: {
            command: { type: 'string', description: 'Command to execute', required: true },
            cwd: { type: 'string', description: 'Working directory' },
            timeout: { type: 'number', description: 'Timeout in ms' },
          },
          returns: 'Command output',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'run',
      'Execute a shell command and return the output',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory for command execution' },
        timeout: { type: 'number', description: 'Command timeout in milliseconds', default: DEFAULT_TIMEOUT },
        env: { type: 'object', description: 'Additional environment variables' },
      }),
      async (args) => {
        const command = args.command as string;
        const cwd = (args.cwd as string) || process.cwd();
        const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
        const env = args.env as Record<string, string> | undefined;

        // Security checks
        this.validateCommand(command);

        return this.executeCommand(command, { cwd, timeout, env });
      },
      { permissionAction: this.getPermissionAction(args => args.command as string) }
    );

    this.registerTool(
      'run_background',
      'Execute a command in the background',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory' },
      }),
      async (args) => {
        const command = args.command as string;
        const cwd = (args.cwd as string) || process.cwd();

        this.validateCommand(command);

        // Run detached process
        const child = spawn('sh', ['-c', command], {
          cwd,
          detached: true,
          stdio: 'ignore',
        });

        child.unref();

        return { pid: child.pid, command, status: 'running' };
      },
      { permissionAction: 'execute' }
    );

    this.registerTool(
      'which',
      'Find the location of an executable',
      createParameterSchema({
        name: { type: 'string', description: 'Executable name', required: true },
      }),
      async (args) => {
        const result = await this.executeCommand(`which ${args.name}`, { timeout: 5000 });
        return { executable: args.name, path: result.stdout.trim() || null };
      },
      { permissionAction: 'execute', requiresPermission: false }
    );

    this.registerTool(
      'env',
      'Get environment variables',
      createParameterSchema({
        name: { type: 'string', description: 'Specific variable name (optional)' },
      }),
      async (args) => {
        if (args.name) {
          return { [args.name as string]: process.env[args.name as string] || null };
        }
        // Filter sensitive variables
        const filtered = { ...process.env };
        const sensitiveKeys = ['PASSWORD', 'SECRET', 'KEY', 'TOKEN', 'CREDENTIAL'];
        for (const key of Object.keys(filtered)) {
          if (sensitiveKeys.some((s) => key.toUpperCase().includes(s))) {
            filtered[key] = '[REDACTED]';
          }
        }
        return filtered;
      },
      { requiresPermission: false }
    );
  }

  private validateCommand(command: string): void {
    const lowerCommand = command.toLowerCase();

    // Check for blocked commands
    for (const blocked of BLOCKED_COMMANDS) {
      if (lowerCommand.includes(blocked.toLowerCase())) {
        throw new Error(`Blocked command detected: ${blocked}`);
      }
    }

    // Check for shell injection patterns
    const injectionPatterns = [
      /;\s*rm\s+/i,
      /\|\s*rm\s+/i,
      /`.*rm.*`/i,
      /\$\(.*rm.*\)/i,
      />\s*\/dev\/sd/i,
      />\s*\/dev\/hd/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(command)) {
        throw new Error('Potential command injection detected');
      }
    }
  }

  private getPermissionAction(getCommand: (args: Record<string, unknown>) => string): string {
    return 'execute'; // Could be made dynamic based on command analysis
  }

  private async executeCommand(
    command: string,
    options: { cwd?: string; timeout?: number; env?: Record<string, string> }
  ): Promise<{ stdout: string; stderr: string; exitCode: number; killed: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        timeout: options.timeout,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        if (stdout.length + chunk.length <= MAX_OUTPUT_SIZE) {
          stdout += chunk;
        }
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        if (stderr.length + chunk.length <= MAX_OUTPUT_SIZE) {
          stderr += chunk;
        }
      });

      const timeout = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, options.timeout || DEFAULT_TIMEOUT);

      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          killed,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}

export const shellTool = new ShellTool();
