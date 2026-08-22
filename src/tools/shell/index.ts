import { resolve } from 'path';
import { getConfig } from '@/config';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';
import { interpretExit } from './exit-code-semantics';
import { LocalShellOperations } from './local-operations';
import type { ShellOperations } from './operations';

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
  // Data exfiltration / reverse shell tools
  'nc ',
  'nc -',
  'ncat ',
  'ncat -',
  'netcat ',
  'netcat -',
  // Process management — prevent agents from killing Octipus or other processes
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
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
  'docker',
  'podman',
  'mount',
  'umount',
  'iptables',
  'ip6tables',
  'nft',
  // Process management — prevent accidental self-kill
  'kill',
  'pkill',
  'killall',
  'xkill',
];

export class ShellTool extends BaseTool {
  readonly id = 'shell';
  readonly name = 'Shell';
  readonly version = '1.0.0';
  readonly description = 'Execute shell commands in a sandboxed environment';

  private readonly ops: ShellOperations;

  constructor(operations?: ShellOperations) {
    super();
    this.ops = operations ?? new LocalShellOperations();
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'execute', description: 'Run shell commands (npm, bun, make, curl, etc.) in the workspace directory', defaultLevel: 'ASK' },
        { action: 'execute_elevated', description: 'Run privileged commands requiring sudo/root access (install packages, manage services, modify system config)', defaultLevel: 'DENY', dangerous: true },
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
      'Execute a shell command and return the output. Simple commands are spawned directly with no shell. Set useShell:true if you need pipes, redirects, or command substitution (audited).',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory for command execution' },
        timeout: { type: 'number', description: 'Command timeout in milliseconds', default: DEFAULT_TIMEOUT },
        env: { type: 'object', description: 'Additional environment variables' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new Error('Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const command = args.command;
        const projectPath = (context?.metadata as Record<string, unknown>)?.projectPath as string | undefined;
        const cwd = (args.cwd as string) || projectPath || this.getWorkspaceRoot(context);
        const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
        const env = args.env as Record<string, string> | undefined;
        const unsafe = args.useShell === true;

        // Security checks
        this.validateCommand(command);

        toolLogger.info({
          command: command.slice(0, 500),
          cwd,
          unsafe,
          agentId: context?.id,
          role: context?.role,
        }, 'Shell command executing');

        const result = await this.ops.exec(command, cwd, { timeout, env, unsafe });

        // Classify the exit code so the agent isn't misled by non-zero codes
        // that are semantically normal (grep=1 "no match", diff=1 "files differ").
        // A killed command is an error whatever its exit code — but the model
        // is told WHICH kill, and what the budget was, because "retry it" and
        // "raise the timeout or split the work" are different next moves.
        const interpretation = result.exitCode !== null && !result.killed
          ? interpretExit(command, result.exitCode)
          : {
              outcome: 'error' as const,
              semantic: result.timedOut
                ? `timed_out_after_${timeout}ms`
                : result.aborted
                  ? 'cancelled'
                  : undefined,
            };

        if (interpretation.outcome === 'error') {
          toolLogger.warn({
            command: command.slice(0, 200),
            exitCode: result.exitCode,
            killed: result.killed,
            timedOut: result.timedOut,
            signal: result.signal,
            stderrSnippet: result.stderr.slice(0, 200),
            agentId: context?.id,
          }, 'Shell command failed');
        }

        return {
          ...result,
          outcome: interpretation.outcome,
          ...(interpretation.semantic ? { semantic: interpretation.semantic } : {}),
        };
      },
      { permissionAction: (args) => this.resolvePermissionAction(args.command as string) }
    );

    this.registerTool(
      'run_background',
      'Execute a command in the background (detached). Safe by default: simple commands are spawned with no shell. Set useShell:true only if you need pipes, redirects, or command substitution (audited).',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Additional environment variables' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new Error('Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const command = args.command;
        const cwd = (args.cwd as string) || this.getWorkspaceRoot(context);
        const env = args.env as Record<string, string> | undefined;
        const unsafe = args.useShell === true;

        // Same security contract as `run`: denylist + injection checks, then
        // the operations layer tokenizes (or refuses) the command. No raw
        // `sh -c` bypass.
        this.validateCommand(command);

        toolLogger.info({
          command: command.slice(0, 500),
          cwd,
          unsafe,
          background: true,
          agentId: context?.id,
          role: context?.role,
        }, 'Shell background command spawning');

        const { pid } = await this.ops.spawnBackground(command, cwd, { env, unsafe });

        return { pid, command, status: 'running' };
      },
      { permissionAction: (args) => this.resolvePermissionAction(args.command as string) }
    );

    this.registerTool(
      'which',
      'Find the location of an executable',
      createParameterSchema({
        name: { type: 'string', description: 'Executable name', required: true },
      }),
      async (args) => {
        const name = String(args.name);
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
          throw new Error(`Invalid executable name: ${name}`);
        }
        const path = await this.ops.which(name);
        return { executable: name, path };
      },
      { permissionAction: 'execute', requiresPermission: false }
    );

    this.registerTool(
      'env',
      'Get a specific environment variable by name. Bulk-listing is intentionally not supported — pass a name.',
      createParameterSchema({
        name: { type: 'string', description: 'Variable name to read', required: true },
      }),
      async (args) => {
        if (typeof args.name !== 'string' || !args.name) {
          throw new Error('env requires a "name" parameter — bulk env dump is not exposed.');
        }
        const envVars = await this.ops.getEnv(args.name);
        return { [args.name]: envVars[args.name] ?? null };
      },
      { requiresPermission: true }
    );
  }

  /**
   * The directory a command runs in when the caller names none.
   *
   * MUST be the same root the filesystem sandbox enforces —
   * `WorkspaceFS.forAgent` nests every real user under
   * `<rootPath>/users/<uid>/workspaces/default/files`, while the flat
   * `config.workspace.rootPath` is two levels above it. Defaulting to the flat
   * path meant `shell__run` started in a different directory than every
   * `filesystem__*` call, so a relative `python3 test_ipv4.py` could not find
   * the file the agent had just written, and a heredoc landed OUTSIDE the
   * user's workspace.
   *
   * That is not only a usability wart: it fails runs. On 2026-08-07 an
   * Implementation stage made 27 tool calls, ran 13 commands and committed —
   * and the evidence gate recorded `filesChanged: 0, filesTouched: 0`, because
   * the work went somewhere the workspace snapshot does not look. The stage was
   * failed for doing nothing while it had in fact done the job in the wrong
   * place.
   *
   * `.root` is a pure path computation with no filesystem side effects. Same
   * fix, same reason as the workspace hint in `worker-spawner.ts`.
   */
  private getWorkspaceRoot(context?: { userId?: string }): string {
    try {
      return WorkspaceFS.forAgent({ userId: context?.userId }).root;
    } catch {
      try {
        return resolve(getConfig().workspace.rootPath);
      } catch {
        return process.cwd();
      }
    }
  }

  private validateCommand(command: string): void {
    // Normalize runs of whitespace so trivial evasions of the denylist
    // (`rm -rf  /`, tabs, newlines between tokens) still match.
    const lowerCommand = command.toLowerCase().replace(/\s+/g, ' ');

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
      // Data exfiltration: piping output to network tools
      /\|\s*curl\s+/i,
      /\|\s*wget\s+/i,
      /\|\s*nc\s+/i,
      /\|\s*ncat\s+/i,
      /\|\s*netcat\s+/i,
      // Suspicious backtick command substitution (nested command execution)
      /`[^`]*`.*`[^`]*`/i,
      // Suspicious $(...) expansion piping to network tools
      /\$\(.*\).*\|\s*(curl|wget|nc|ncat|netcat)\s/i,
    ];

    for (const pattern of injectionPatterns) {
      if (pattern.test(command)) {
        throw new Error('Potential command injection detected');
      }
    }

    const elevated = this.matchElevatedCommand(command);
    if (elevated) {
      toolLogger.warn({ command: command.slice(0, 200), elevated }, 'Elevated command detected — requires elevated permission');
    }
  }

  /**
   * Return the elevated keyword if the command invokes a privileged tool at
   * the start of the line or after a pipe/`;`/`&&` separator, else null.
   */
  private matchElevatedCommand(command: string): string | null {
    for (const elevated of ELEVATED_COMMANDS) {
      const patterns = [
        new RegExp(`^${elevated}\\b`, 'i'),
        new RegExp(`\\|\\s*${elevated}\\b`, 'i'),
        new RegExp(`;\\s*${elevated}\\b`, 'i'),
        new RegExp(`&&\\s*${elevated}\\b`, 'i'),
      ];
      if (patterns.some((p) => p.test(command))) return elevated;
    }
    return null;
  }

  /**
   * Map a command to the permission action it must satisfy. Privileged
   * commands (sudo/docker/systemctl/…) require the `execute_elevated`
   * permission, which defaults to DENY — so they are blocked unless an admin
   * has explicitly granted elevation, instead of running under the ASK-level
   * `execute` permission like ordinary commands.
   */
  private resolvePermissionAction(command: string): string {
    if (typeof command === 'string' && this.matchElevatedCommand(command)) {
      return 'execute_elevated';
    }
    return 'execute';
  }
}

export const shellTool = new ShellTool();
