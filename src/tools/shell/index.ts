import { getExecutionSignal } from '@/core/execution-scope';
import { isToolNotExecutedResult, ToolNotExecutedError } from '@/core/tool-execution-error';
import { isAbsolute, resolve } from 'path';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { isSensitiveEnvName } from '@/security/child-env';
import { HOST_IDENTITY_ENV, openSpaceToolHome, type SpaceToolHome, withToolHome } from '@/security/space-tool-env';
import type { AgentContext, ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';
import { interpretExit } from './exit-code-semantics';
import { LocalShellOperations } from './local-operations';
import type { ShellExecResult, ShellOperations } from './operations';
import { commandPolicyViolation, matchDestructiveCommand, matchElevatedCommand } from './policy';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * How a command runs: the caller's `env`, and in a space (coworking §9.5)
 * the run's own tool home — `HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR` and
 * the version-control config at a fresh directory holding only the space
 * connector's GitHub login, the host's identity variables removed from the
 * inherited environment and from the call's `env` alike, and the home bound
 * into the process sandbox. Exported for the tests.
 */
export function spaceRunOptions(env: Record<string, string> | undefined, home: SpaceToolHome | null): {
  env?: Record<string, string>; unsetEnv?: readonly string[]; extraReadWrite?: string[];
} {
  if (!home) return { env };
  return { env: withToolHome(env ?? {}, home), unsetEnv: HOST_IDENTITY_ENV, extraReadWrite: [home.dir] };
}

/** A fresh tool home for one run of a space agent, or null outside a space. */
async function toolHomeFor(context: AgentContext | undefined): Promise<SpaceToolHome | null> {
  return context?.space ? openSpaceToolHome({ ...context, space: context.space }) : null;
}


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
        { action: 'execute_destructive', description: 'Run commands that destroy work irreversibly (rm -r, rm on a glob, git reset --hard, git clean -f, git push --force, dd, shred, find -delete)', defaultLevel: 'ASK', dangerous: true },
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
        env: { type: 'object', description: 'Additional environment variables. For vault authentication use {"GH_TOKEN":"{{secret:github_token}}"} with command "gh api user" (example; use the real vault name and program-specific variable). Octipus resolves placeholders at execution. Keep secrets out of command text; vendor-native terminal calls do not perform this substitution.' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
        network: { type: 'boolean', description: 'Set true when the command needs the internet (npm install, pip install, git fetch/push, curl). Only has an effect when the process sandbox is enabled, where commands are network-isolated by default. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new ToolNotExecutedError('shell', 'Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const command = args.command;
        const cwd = this.resolveCwd(args.cwd, context);
        const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;
        const unsafe = args.useShell === true;
        const allowNetwork = args.network === true;

        // Security checks
        this.validateCommand(command);

        toolLogger.info({
          command: command.slice(0, 500),
          cwd,
          unsafe,
          agentId: context?.id,
          role: context?.role,
        }, 'Shell command executing');

        const home = await toolHomeFor(context);
        let result: ShellExecResult;
        try {
          result = await this.ops.exec(command, cwd, {
            timeout, unsafe, allowNetwork, signal: getExecutionSignal(context),
            ...spaceRunOptions(args.env as Record<string, string> | undefined, home),
          });
        } finally {
          home?.dispose();
        }

        if (result.aborted) {
          if (isToolNotExecutedResult('shell', result)) throw new ToolNotExecutedError('shell', 'Shell command cancelled before execution');
          throw new Error('Shell command cancelled');
        }

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
        env: { type: 'object', description: 'Additional environment variables. For vault authentication use {"GH_TOKEN":"{{secret:github_token}}"} with command "gh api user" (example; use the real vault name and program-specific variable). Octipus resolves placeholders at execution. Keep secrets out of command text; vendor-native terminal calls do not perform this substitution.' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
        network: { type: 'boolean', description: 'Set true when the command needs the internet (npm install, pip install, git fetch/push, curl). Only has an effect when the process sandbox is enabled, where commands are network-isolated by default. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new Error('Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const command = args.command;
        const cwd = this.resolveCwd(args.cwd, context);
        const unsafe = args.useShell === true;
        const allowNetwork = args.network === true;

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

        // The tool home lives as long as the background process.
        const home = await toolHomeFor(context);
        let pid: number | undefined;
        try {
          ({ pid } = await this.ops.spawnBackground(command, cwd, {
            unsafe, allowNetwork, ...spaceRunOptions(args.env as Record<string, string> | undefined, home), onExit: () => home?.dispose(),
          }));
        } catch (err) {
          home?.dispose();
          throw err;
        }

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
        // A withheld credential must not look like an unset variable: an agent
        // told `null` concludes the key is missing and goes and sets one.
        if (isSensitiveEnvName(args.name)) {
          return { [args.name]: null, redacted: true, reason: 'looks like a credential — withheld' };
        }
        const envVars = await this.ops.getEnv(args.name);
        return { [args.name]: envVars[args.name] ?? null };
      },
      { requiresPermission: true }
    );
  }

  /**
   * The directory a command runs in when the caller names none: the
   * dev-mode project when the agent has one, else its workspace root.
   *
   * MUST be the same root the filesystem sandbox enforces —
   * `WorkspaceFS.forAgent` nests every user's workspace under
   * `<rootPath>/users/<uid>/workspaces/<workspace>/files`, while the flat
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
  private getWorkspaceRoot(context: AgentContext): string {
    return this.projectPath(context) ?? WorkspaceFS.forAgent(context).root;
  }

  private projectPath(context: AgentContext): string | undefined {
    const projectPath = (context.metadata as Record<string, unknown> | undefined)?.projectPath;
    return typeof projectPath === 'string' && projectPath ? resolve(projectPath) : undefined;
  }

  /**
   * The directory a command runs in. A named `cwd` must lie inside the
   * agent's workspace root, an allowed extra (`workspace.additionalPaths`,
   * the transient-file prefix) or the dev-mode `projectPath`; a relative one
   * is taken from the project, else the workspace root. This keeps commands
   * where the agent's files are, so the evidence gate and the Changes tab see
   * the work — correctness, not a sandbox: a command can still `cd` wherever
   * the process may.
   */
  private resolveCwd(requested: unknown, context: AgentContext | undefined): string {
    if (!context) {
      throw new ToolNotExecutedError('shell', 'shell commands run for an agent: no agent context was given');
    }
    const base = this.getWorkspaceRoot(context);
    if (requested === undefined || requested === null || requested === '') return base;
    if (typeof requested !== 'string') {
      throw new ToolNotExecutedError('shell', 'cwd must be a string');
    }
    const projectPath = this.projectPath(context);
    const fs = WorkspaceFS.forAgent(context, { extraAllowedPrefixes: projectPath ? [projectPath] : [] });
    try {
      return fs.resolve(isAbsolute(requested) ? requested : resolve(base, requested));
    } catch (err) {
      if (err instanceof WorkspaceFsError) {
        throw new ToolNotExecutedError('shell', `cwd '${requested}' is outside the workspace; run the command from the workspace or the project`);
      }
      throw err;
    }
  }

  private validateCommand(command: string): void {
    // Content policy lives in `./policy` so the `command_exit_zero` scorer
    // enforces the same denylist rather than a second copy of it.
    const violation = commandPolicyViolation(command);
    if (violation) throw new ToolNotExecutedError('shell', violation);

    const elevated = matchElevatedCommand(command);
    if (elevated) {
      toolLogger.warn({ command: command.slice(0, 200), elevated }, 'Elevated command detected — requires elevated permission');
    }
  }

  /**
   * Map a command to the permission action it must satisfy. Privileged
   * commands (sudo/docker/systemctl/…) require the `execute_elevated`
   * permission, which defaults to DENY — so they are blocked unless an admin
   * has explicitly granted elevation, instead of running under the ASK-level
   * `execute` permission like ordinary commands.
   */
  /**
   * Which permission a command answers to.
   *
   * Elevation is checked first because it is DENY by default and therefore the
   * stricter answer. Destruction is checked second and separately: it needs no
   * privilege, so an `rm -rf` sailed through the elevated check and landed on
   * plain `execute` — ASK, which auto-approves for any caller that cannot be
   * asked. That is how a spawned child emptied a directory with no prompt.
   */
  private resolvePermissionAction(command: string): string {
    if (typeof command !== 'string') return 'execute';
    if (matchElevatedCommand(command)) return 'execute_elevated';
    if (matchDestructiveCommand(command)) return 'execute_destructive';
    return 'execute';
  }
}

export const shellTool = new ShellTool();
