import { environmentCredentialOptions } from '@/security/environment-credentials';
import { environmentShellOptions, shellOperationsFor } from '@/security/environment-runtime';
import { executionEnvironmentFor, hasAccountAuthority } from '@/security/execution-environments';
import { environmentToolHome } from '@/security/environment-identity';
import { withCliKubeconfig } from '@/security/cli-kubeconfig';
import { isApprovedCall } from '@/security/approved-calls';
import { implicitVerificationCommand } from '@/security/verification-command';
import { profileAllows, profileVerificationRewrite, runPermissionProfile } from '@/security/pipeline-permissions';
import { resolveShellCwd } from '@/security/shell-cwd';
import { redactedCommand } from '@/utils/command-log';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { browserRuntimeDiagnostic, browserRuntimeMounts, browserRuntimePaths } from '@/security/runtime-path';
import { getExecutionSignal } from '@/core/execution-scope';
import { isToolNotExecutedResult, ToolNotExecutedError, ToolPolicyRefusalError } from '@/core/tool-execution-error';
import { WorkspaceFS } from '@/security/workspace-fs';
import { personalBuildCaches } from '@/security/build-caches';
import { isSensitiveEnvName } from '@/security/child-env';
import { HOST_IDENTITY_ENV, openSpaceToolHome, type SpaceToolHome, withToolHome } from '@/security/space-tool-env';
import type { AgentContext, ToolManifest } from '@/core/types';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema, type ToolContext } from '../base-tool';
import { interpretExit } from './exit-code-semantics';
import { LocalShellOperations } from './local-operations';
import type { ShellExecResult, ShellOperations } from './operations';
import { commandPolicyViolation, matchDestructiveCommand, matchElevatedCommand } from './policy';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

/** Pipeline stages run whole gate suites (go test -race, pnpm -r test), often two at once; a shorter limit only kills them mid-run and gates the stage behind recovery review (#55, #69: a 4-min Go gate ran past 10 min beside pnpm -r test). */
// ponytail: 30 min fixed floor; make it per-run (profile) if a suite ever needs longer.
export const PIPELINE_SHELL_TIMEOUT_FLOOR_MS = 1_800_000;

export function effectiveShellTimeout(requested: unknown, metadata?: Record<string, unknown>): number {
  const asked = typeof requested === 'number' && requested > 0 ? requested : DEFAULT_TIMEOUT;
  return typeof metadata?.pipelineId === 'string' ? Math.max(asked, PIPELINE_SHELL_TIMEOUT_FLOOR_MS) : asked;
}

/**
 * How a command runs: the caller's `env`, and in a space (coworking §9.5)
 * the run's own tool home — `HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR` and
 * the version-control config at a fresh directory holding only the space
 * connector's GitHub login, the host's identity variables removed from the
 * inherited environment and from the call's `env` alike, and the home bound
 * into the process sandbox. Exported for the tests.
 */
export function spaceRunOptions(env: Record<string, string> | undefined, home: SpaceToolHome | null): {
  env?: Record<string, string>; unsetEnv?: readonly string[]; extraReadWrite?: string[]; extraReadOnly?: string[];
} {
  if (!home) return { env, extraReadOnly: [join(homedir(), '.gitconfig'), join(homedir(), '.config/git/config')] };
  return { env: withToolHome(env ?? {}, home), unsetEnv: HOST_IDENTITY_ENV, extraReadWrite: [home.dir] };
}

/** Shell and filesystem tools share the caller's approved host directories. */
export function shellRunOptions(context: AgentContext, env: Record<string, string> | undefined, home: SpaceToolHome | null, cwd?: string) {
  const profile = executionEnvironmentFor(context);
  if (profile?.backend === 'ssh') return { ...environmentShellOptions(context), env, allowedCwdRoots: profile.roots };
  const fs = WorkspaceFS.forAgent(context);
  fs.ensureRootSync();
  const options = spaceRunOptions(env, home);
  const roots = fs.persistentRoots();
  const caches = fs.isSpace || (profile && !profile.hostIdentity) ? undefined : personalBuildCaches();
  const runtime = environmentShellOptions(context);
  return {
    ...options,
    ...runtime,
    env: { ...caches?.env, ...options.env, ...runtime.env },
    allowHostSshAgent: !fs.isSpace && (runtime.allowHostSshAgent ?? true),
    extraReadOnly: [...(options.extraReadOnly ?? []), ...(runtime.extraReadOnly ?? [])],
    extraReadWrite: [...roots, ...(runtime.extraReadWrite ?? []), ...(options.extraReadWrite ?? []), ...(caches?.paths ?? [])],
    allowedCwdRoots: [...roots, ...(cwd ? [fs.resolve(cwd)] : [])],
  };
}

/**
 * A pipeline stage that opted into `hostServices` (off by default): host
 * network, Docker socket and USB devices, so builds and physical-device tests
 * work under the process sandbox. Exported for the tests.
 */
export function withHostServices<T extends { allowNetwork?: boolean; extraReadWrite?: string[]; extraReadOnly?: string[]; env?: Record<string, string> }>(
  metadata: Record<string, unknown> | undefined, options: T,
): T {
  return { ...options, ...(metadata?.hostServices === true ? { allowNetwork: true, allowHostUsb: true, extraReadWrite: [...(options.extraReadWrite ?? []), '/var/run/docker.sock'] } : {}),
    extraReadOnly: [...(options.extraReadOnly ?? []), ...browserRuntimeMounts()],
    env: { ...options.env, PLAYWRIGHT_BROWSERS_PATH: options.env?.PLAYWRIGHT_BROWSERS_PATH ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? browserRuntimePaths()[0] } };
}

/** A fresh tool home for one run of a space agent, or null outside a space. */
async function toolHomeFor(context: AgentContext | undefined): Promise<SpaceToolHome | null> {
  return context?.space ? openSpaceToolHome({ ...context, space: context.space }) : context ? environmentToolHome(context) : null;
}


export class ShellTool extends BaseTool {
  readonly id = 'shell';
  readonly name = 'Shell';
  readonly version = '1.0.0';
  readonly description = 'Execute commands in the session’s selected execution environment';

  private readonly ops: ShellOperations;

  constructor(operations?: ShellOperations) {
    super();
    this.ops = operations ?? new LocalShellOperations();
  }

  getManifest(): ToolManifest {
    return {
      execution: { kind: 'environment' },
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Inspect executable locations and non-secret runtime variables', defaultLevel: 'ALLOW' },
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
      'Execute a shell command and return the output. Keep persistent files and Git worktrees inside the workspace, project, or configured additional workspace directories; these share host storage with filesystem tools. Other unmounted directories are read-only; /tmp is temporary per command. Simple commands are spawned directly with no shell. Set useShell:true if you need pipes, redirects, or command substitution (audited).',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory for command execution' },
        timeout: { type: 'number', description: 'Command timeout in milliseconds', default: DEFAULT_TIMEOUT },
        env: { type: 'object', description: 'Additional non-secret environment variables. Vault interpolation is prohibited in shell arguments, including env. Use a configured authenticated integration for credential-consuming operations.' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
        network: { type: 'boolean', description: 'Set true when the command needs the internet (npm install, pip install, git fetch/push, curl). Only has an effect when the process sandbox is enabled, where commands are network-isolated by default. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new ToolNotExecutedError('shell', 'Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const requestedCommand = args.command;
        const cwd = resolveShellCwd(args.cwd, context);
        const command = await this.profileCommand({ ...args, cwd }, context, 'run');
        const timeout = effectiveShellTimeout(args.timeout, context?.metadata);
        const unsafe = args.useShell === true;
        const allowNetwork = args.network === true;

        // Security checks
        this.validateCommand(command, context);

        toolLogger.info({
          command: redactedCommand(command),
          ...(command !== requestedCommand ? { requestedCommand: redactedCommand(requestedCommand), rewriteReason: 'Execute the approved verification target; omit fallback annotations and anchor Compose shorthand' } : {}),
          cwd,
          unsafe,
          agentId: context?.id,
          role: context?.role,
        }, 'Shell command executing');

        const home = await toolHomeFor(context);
        let result: ShellExecResult;
        try {
          const credentials = await environmentCredentialOptions(context, withCliKubeconfig(context, withHostServices(executionEnvironmentFor(context) ? undefined : context?.metadata, {
            timeout, unsafe, allowNetwork, signal: getExecutionSignal(context),
            ...shellRunOptions(context, args.env as Record<string, string> | undefined, home, cwd),
          })));
          try { result = credentials.mask(await shellOperationsFor(context, this.ops).exec(command, cwd, credentials.options)); }
          catch (error) { throw credentials.maskError(error); }
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
          ? interpretExit(command, result.exitCode, result.stderr)
          : {
              outcome: 'error' as const,
              semantic: result.timedOut
                ? `timed_out_after_${timeout}ms`
                : result.aborted
                  ? 'cancelled'
                  : undefined,
            };

        if (interpretation.outcome === 'expected_nonzero' && interpretation.semantic === 'no_match') {
          toolLogger.info({ command: redactedCommand(command), exitCode: result.exitCode, agentId: context?.id, semantic: 'no_match' }, 'Shell search completed with no matches');
        }
        if (interpretation.outcome === 'error') {
          toolLogger.warn({
            command: redactedCommand(command),
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
          ...(command !== requestedCommand ? { requestedCommand: redactedCommand(requestedCommand), executedCommand: redactedCommand(command), rewriteReason: command.startsWith('ssh ') ? 'Anchored to the explicitly approved Compose file' : 'Execute the approved verification command without its fallback comment' } : {}),
          ...(browserRuntimeDiagnostic(result.stderr) ? { environmentDiagnostic: browserRuntimeDiagnostic(result.stderr) } : {}),
          outcome: interpretation.outcome,
          ...(interpretation.semantic ? { semantic: interpretation.semantic } : {}),
        };
      },
      { permissionAction: (args) => this.resolvePermissionAction(args.command as string) }
    );

    this.registerTool(
      'run_background',
      'Execute a command in the background (detached), with the same persistent workspace/project/additional-directory access as run and filesystem tools. /tmp is temporary per command. Safe by default: simple commands are spawned with no shell. Set useShell:true only if you need pipes, redirects, or command substitution (audited).',
      createParameterSchema({
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory' },
        env: { type: 'object', description: 'Additional non-secret environment variables. Vault interpolation is prohibited in shell arguments, including env. Use a configured authenticated integration for credential-consuming operations.' },
        useShell: { type: 'boolean', description: 'Set true ONLY when the command genuinely needs shell features (pipes, redirects, $(), backticks). Audited. Default false.', default: false },
        network: { type: 'boolean', description: 'Set true when the command needs the internet (npm install, pip install, git fetch/push, curl). Only has an effect when the process sandbox is enabled, where commands are network-isolated by default. Default false.', default: false },
      }),
      async (args, context) => {
        if (typeof args.command !== 'string' || !args.command) {
          throw new Error('Missing required parameter "command". The tool call arguments may have been truncated or malformed.');
        }
        const requestedCommand = args.command;
        const cwd = resolveShellCwd(args.cwd, context);
        const command = await this.profileCommand({ ...args, cwd }, context, 'run_background');
        const unsafe = args.useShell === true;
        const allowNetwork = args.network === true;

        // Same security contract as `run`: denylist + injection checks, then
        // the operations layer tokenizes (or refuses) the command. No raw
        // `sh -c` bypass.
        this.validateCommand(command, context);

        toolLogger.info({
          command: redactedCommand(command),
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
          const credentials = await environmentCredentialOptions(context, withCliKubeconfig(context, withHostServices(executionEnvironmentFor(context) ? undefined : context?.metadata, {
            unsafe, allowNetwork, ...shellRunOptions(context, args.env as Record<string, string> | undefined, home, cwd),
            onExit: () => home?.dispose(),
          })));
          try { ({ pid } = await shellOperationsFor(context, this.ops).spawnBackground(command, cwd, credentials.options)); }
          catch (error) { throw credentials.maskError(error); }
        } catch (err) {
          home?.dispose();
          throw err;
        }

        return { pid, command, status: 'running', ...(command !== requestedCommand ? { requestedCommand: redactedCommand(requestedCommand), executedCommand: redactedCommand(command), rewriteReason: command.startsWith('ssh ') ? 'Anchored to the explicitly approved Compose file' : 'Execute the approved verification command without its fallback comment' } : {}) };
      },
      { permissionAction: (args) => this.resolvePermissionAction(args.command as string) }
    );

    this.registerTool(
      'which',
      'Find the location of an executable',
      createParameterSchema({
        name: { type: 'string', description: 'Executable name', required: true },
      }),
      async (args, context) => {
        const name = String(args.name);
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
          throw new Error(`Invalid executable name: ${name}`);
        }
        const profile = executionEnvironmentFor(context);
        if (profile) {
          const home = await toolHomeFor(context);
          try {
            const result = await shellOperationsFor(context, this.ops).exec(`command -v '${name}'`, profile.roots[0], { ...shellRunOptions(context, undefined, home), unsafe: true, timeout: 15000 });
            return { executable: name, path: result.exitCode === 0 ? result.stdout.trim() : null, environmentId: profile.id };
          } finally { home?.dispose(); }
        }
        const path = await this.ops.which(name);
        return { executable: name, path };
      },
      { permissionAction: 'read', readOnly: true }
    );

    this.registerTool(
      'env',
      'Get a specific environment variable by name. Bulk-listing is intentionally not supported — pass a name.',
      createParameterSchema({
        name: { type: 'string', description: 'Variable name to read', required: true },
      }),
      async (args, context) => {
        if (typeof args.name !== 'string' || !args.name) {
          throw new Error('env requires a "name" parameter — bulk env dump is not exposed.');
        }
        // A withheld credential must not look like an unset variable: an agent
        // told `null` concludes the key is missing and goes and sets one.
        if (isSensitiveEnvName(args.name)) {
          return { [args.name]: null, redacted: true, reason: 'looks like a credential — withheld' };
        }
        const profile = executionEnvironmentFor(context);
        if (profile) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.name)) throw new ToolNotExecutedError('shell', 'Choose one variable name');
          if (profile.credentials.some(binding => binding.variable === args.name)) return { [args.name]: null, redacted: true, reason: 'bound credential — withheld' };
          const home = await toolHomeFor(context);
          try {
            const { quoteRuntimeArg } = await import('@/security/environment-runtime');
            const code = `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(args.name)}]??null))`;
            const result = await shellOperationsFor(context, this.ops).exec(`${profile.backend === 'ssh' ? 'node' : quoteRuntimeArg(process.execPath)} -e ${quoteRuntimeArg(code)}`, profile.roots[0], { ...shellRunOptions(context, undefined, home), timeout: 15000 });
            if (result.exitCode !== 0) throw new Error('Could not inspect the selected runtime variable');
            return { [args.name]: JSON.parse(result.stdout) };
          } finally { home?.dispose(); }
        }
        const envVars = await this.ops.getEnv(args.name);
        return { [args.name]: envVars[args.name] ?? null };
      },
      { permissionAction: 'read', readOnly: true }
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

  /**
   * The directory a command runs in. A named `cwd` must lie inside the
   * agent's workspace root, an allowed extra (`workspace.additionalPaths`,
   * the transient-file prefix) or the dev-mode `projectPath`; a relative one
   * is taken from the project, else the workspace root. This keeps commands
   * where the agent's files are, so the evidence gate and the Changes tab see
   * the work — correctness, not a sandbox: a command can still `cd` wherever
   * the process may.
   */

  private async profileCommand(args: Record<string, unknown>, context: AgentContext, toolName: string): Promise<string> {
    const requested = args.command as string;
    const call = { toolId: this.id, action: this.resolvePermissionAction(requested), toolName, args };
    const run = await runPermissionProfile(context);
    if ((context as ToolContext).authorizationSource?.startsWith('execution-environment:')) return requested;
    if (run?.profile.executionScope === 'run' && profileAllows(run.profile, call)) return requested;
    if (run?.profile.commands.includes(requested)) return requested;
    const rewritten = run ? profileVerificationRewrite(run.profile, call) : undefined;
    if (rewritten) return rewritten;
    if (typeof context.metadata?.pipelineId === 'string' && implicitVerificationCommand(requested)
      && !(context as ToolContext).authorizationSource?.startsWith('approval:')
      && !await isApprovedCall(context, call, { requireFlowConsent: true })) {
      throw new ToolNotExecutedError('shell', 'The current approved Compose anchor is unavailable. No remote command was executed; use an explicit approved -f command or obtain consent for discovery.');
    }
    return requested;
  }

  private validateCommand(command: string, context: AgentContext): void {
    // Content policy lives in `./policy` so the `command_exit_zero` scorer
    // enforces the same denylist rather than a second copy of it.
    const violation = hasAccountAuthority(context) ? null : commandPolicyViolation(command);
    if (violation) throw new ToolPolicyRefusalError('shell', violation);

    const elevated = matchElevatedCommand(command);
    if (elevated) {
      toolLogger.warn({ command: redactedCommand(command), elevated }, 'Elevated command detected — requires elevated permission');
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
