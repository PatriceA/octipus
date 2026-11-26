import { getExecutionSignal } from '@/core/execution-scope';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ConfigEntry, neutralizingArgs, parseConfigListing, refusedKeys, shellQuote } from './repo-config';
import { HARDENED_GIT_ARGS } from '@/security/git-hardening';
import { toolLogger } from '@/utils/logger';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { activeEgressPolicy, currentEgressSubject, egressPolicyActive } from '@/security/egress-policy';
import { enforceGitRemotes, gitRemoteTarget } from '@/security/git-egress';
import { environmentCredentialOptions } from '@/security/environment-credentials';
import { environmentToolHome } from '@/security/environment-identity';
import { executionEnvironmentFor } from '@/security/execution-environments';
import { environmentShellOptions, shellOperationsFor, quoteRuntimeArg, resolveEnvironmentCwd } from '@/security/environment-runtime';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'child_process';
import { buildChildEnv } from '@/security/child-env';
import { HOST_IDENTITY_ENV, openSpaceToolHome, type SpaceToolHome, withToolHome } from '@/security/space-tool-env';
import type { AgentContext, ToolManifest } from '@/core/types';
import { BaseTool, createParameterSchema, type ToolExecutionOptions } from '../base-tool';
import { tokenizeSafe } from '../shell/policy';

/**
 * `git add`'s `files` → argv. Tokenized, not split on ' ': a path with a space
 * ("My Docs/a.txt") must stay one entry. Arrays pass through for programmatic
 * callers. Refuses rather than guesses on unbalanced quotes / metacharacters.
 */
export function parseAddFiles(files: unknown): string[] {
  const list = Array.isArray(files)
    ? files.map(String).filter(Boolean)
    : tokenizeSafe(String(files ?? ''));
  if (!list?.length) {
    throw new Error('git add: `files` must be a non-empty list of paths (quote paths with spaces; no shell metacharacters)');
  }
  return list;
}

const ADD_FLAGS = new Set(['-A', '--all', '-u', '--update']);

export class GitTool extends BaseTool {
  readonly id = 'git';
  readonly name = 'Git';
  readonly version = '1.0.0';
  readonly description = 'Git version control operations';

  getManifest(): ToolManifest {
    return {
      execution: { kind: 'environment', program: 'git' },
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read git repository status, commit history, diffs, and branch info', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Stage files, create commits, switch branches, stash changes, reset HEAD, and clone repositories', defaultLevel: 'ASK' },
        { action: 'push', description: 'Push local commits to remote repositories (e.g. GitHub, GitLab)', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'status',
      'Get git repository status',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
      }),
      async (args) => {
        const result = await this.git(['status', '--porcelain', '-b'], args.path as string);
        return this.parseStatus(result);
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'log',
      'Get git commit history',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        count: { type: 'number', description: 'Number of commits', default: 10 },
        oneline: { type: 'boolean', description: 'One line format', default: false },
      }),
      async (args) => {
        const format = args.oneline ? '--oneline' : '--format=%H|%an|%ae|%at|%s';
        const result = await this.git(['log', `-${gitCount(args.count ?? 10, 'count')}`, format], args.path as string);

        if (args.oneline) {
          return result.split('\n').filter(Boolean);
        }

        return result.split('\n').filter(Boolean).map((line) => {
          const [hash, author, email, timestamp, subject] = line.split('|');
          return { hash, author, email, date: new Date(parseInt(timestamp) * 1000).toISOString(), subject };
        });
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'diff',
      'Show file differences',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        file: { type: 'string', description: 'Specific file to diff' },
        staged: { type: 'boolean', description: 'Show staged changes', default: false },
      }),
      async (args) => {
        // No external diff program, whatever the configuration says.
        const gitArgs = ['diff', '--no-ext-diff', '--no-textconv'];
        if (args.staged) gitArgs.push('--staged');
        if (args.file) gitArgs.push('--', gitArgument(args.file, 'file'));

        return this.git(gitArgs, args.path as string);
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'add',
      'Stage files for commit',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        files: { type: 'string', description: 'Files to stage: space-separated, or "." for all. Quote paths containing spaces ("my file.txt").', required: true },
      }),
      async (args) => {
        const files = parseAddFiles(args.files);
        // `--` so a path starting with `-` is never read as an option; the
        // stage-everything flags models habitually pass stay flags.
        const flags = files.filter(f => ADD_FLAGS.has(f));
        await this.git(['add', ...flags, '--', ...files.filter(f => !ADD_FLAGS.has(f))], args.path as string);
        return { staged: files };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'commit',
      'Create a commit',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        message: { type: 'string', description: 'Commit message', required: true },
      }),
      async (args) => {
        const result = await this.git(['commit', '-m', args.message as string], args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'branch',
      'List or create branches',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        name: { type: 'string', description: 'New branch name (if creating)' },
        checkout: { type: 'boolean', description: 'Checkout new branch', default: false },
      }),
      async (args) => {
        if (args.name) {
          const name = gitRefName(args.name, 'branch name');
          const gitArgs = args.checkout ? ['checkout', '-b', name] : ['branch', name];
          await this.git(gitArgs, args.path as string);
          return { created: args.name, checkedOut: args.checkout };
        }

        const result = await this.git(['branch', '-a'], args.path as string);
        return result.split('\n').filter(Boolean).map((b) => ({
          name: b.replace(/^\*?\s+/, ''),
          current: b.startsWith('*'),
        }));
      },
      // Listing reads; a `name` creates a branch (and `checkout` moves HEAD).
      { permissionAction: (args) => (args.name ? 'write' : 'read') }
    );

    this.registerTool(
      'checkout',
      'Switch branches or restore files',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        target: { type: 'string', description: 'Branch name or commit hash', required: true },
      }),
      async (args) => {
        await this.git(['checkout', gitArgument(args.target, 'target')], args.path as string);
        return { checkedOut: args.target };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'pull',
      'Pull changes from remote',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        remote: { type: 'string', description: 'Remote name', default: 'origin' },
        branch: { type: 'string', description: 'Branch name' },
      }),
      async (args) => {
        // Every positional is checked (no leading `-`: `--upload-pack=<cmd>`
        // would run a command here) and placed after `--`.
        const remote = gitRemoteArgument(args.remote ?? 'origin');
        const gitArgs = ['pull', '--', remote];
        if (args.branch) gitArgs.push(gitRefspec(args.branch));
        await this.judgeRemote('fetch', remote, args.path as string);

        const result = await this.networkGit(gitArgs, args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'push',
      'Push changes to remote',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        remote: { type: 'string', description: 'Remote name', default: 'origin' },
        branch: { type: 'string', description: 'Branch name' },
        setUpstream: { type: 'boolean', description: 'Set upstream', default: false },
      }),
      async (args) => {
        const remote = gitRemoteArgument(args.remote ?? 'origin');
        const gitArgs = ['push'];
        if (args.setUpstream) gitArgs.push('-u');
        gitArgs.push('--', remote);
        if (args.branch) gitArgs.push(gitRefspec(args.branch));
        await this.judgeRemote('push', remote, args.path as string);
        // A push to a repository on this machine runs ITS hooks in a
        // receive-pack that does not inherit our `-c` (git clears config for
        // the other side): that receive-pack gets hooks off itself.
        const receivePack = await this.localReceivePack(remote, args.path as string);
        if (receivePack) gitArgs.splice(1, 0, `--receive-pack=${receivePack}`);

        const result = await this.networkGit(gitArgs, args.path as string);
        return { success: true, output: result };
      },
      { permissionAction: 'push' }
    );

    this.registerTool(
      'stash',
      'Stash changes',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        action: { type: 'string', description: 'Action: save, pop, list, drop', default: 'save', enum: ['save', 'pop', 'list', 'drop'] },
        message: { type: 'string', description: 'Stash message (for save)' },
      }),
      async (args) => {
        const gitArgs = ['stash'];
        const action = args.action as string || 'save';

        if (!['save', 'pop', 'list', 'drop'].includes(action)) throw new ToolNotExecutedError('git', `Unknown stash action: ${action}`);
        if (action === 'save' && args.message) {
          gitArgs.push('push', '-m', args.message as string);
        } else {
          gitArgs.push(action);
        }

        const result = await this.git(gitArgs, args.path as string);
        return { action, output: result };
      },
      // `list` only reads; save, pop and drop change the working tree.
      { permissionAction: (args) => ((args.action as string) === 'list' ? 'read' : 'write') }
    );

    this.registerTool(
      'reset',
      'Reset current HEAD to specified state',
      createParameterSchema({
        path: { type: 'string', description: 'Repository path', default: '.' },
        mode: { type: 'string', description: 'Reset mode', default: 'mixed', enum: ['soft', 'mixed', 'hard'] },
        target: { type: 'string', description: 'Commit to reset to', default: 'HEAD' },
      }),
      async (args) => {
        const mode = (args.mode as string) || 'mixed';
        if (!['soft', 'mixed', 'hard'].includes(mode)) throw new ToolNotExecutedError('git', `Unknown reset mode: ${mode}`);
        const gitArgs = ['reset', `--${mode}`, gitArgument(args.target || 'HEAD', 'target')];
        const result = await this.git(gitArgs, args.path as string);
        return { mode: args.mode, target: args.target, output: result };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'clone',
      'Clone a repository',
      createParameterSchema({
        url: { type: 'string', description: 'Repository URL', required: true },
        path: { type: 'string', description: 'Destination path' },
        depth: { type: 'number', description: 'Shallow clone depth' },
      }),
      async (args) => {
        const url = gitArgument(args.url, 'url');
        const gitArgs = ['clone'];
        if (args.depth) gitArgs.push('--depth', gitCount(args.depth, 'depth'));
        gitArgs.push('--', url);
        if (args.path) gitArgs.push(gitArgument(args.path, 'path'));
        await this.judgeRemote('fetch', url, '.');

        const _result = await this.networkGit(gitArgs, '.', false);
        return { cloned: args.url, path: args.path || (args.url as string).split('/').pop()?.replace('.git', '') };
      },
      { permissionAction: 'write' }
    );
  }

  /**
   * Under an active egress policy, judge the URLs git is about to contact
   * (src/security/git-egress.ts), as git will resolve them: `insteadOf`
   * applied (`ls-remote --get-url`), and for a push the push URLs — a remote's
   * `pushurl`s, or a URL rewritten by `pushInsteadOf`, which `ls-remote`
   * does not apply. Asking git touches no network. No policy: no extra git
   * call.
   */
  private async judgeRemote(direction: 'fetch' | 'push', remote: string, cwd: string): Promise<void> {
    if (!currentEgressSubject() || !egressPolicyActive(activeEgressPolicy())) return;
    const named = /^[A-Za-z0-9._-]+$/.test(remote) && gitRemoteTarget(remote) === null;
    const lines = (out: string) => out.split('\n').map((line) => line.trim()).filter(Boolean);
    const urls = lines(await this.git(['ls-remote', '--get-url', '--', remote], cwd));
    if (direction === 'push') {
      if (named) urls.push(...lines(await this.git(['remote', 'get-url', '--push', '--all', '--', remote], cwd)));
      else {
        const rules = lines(await this.git(['config', '--get-regexp', '^url\\..*\\.pushinsteadof$'], cwd).catch(() => ''));
        const pushed = rewriteInsteadOf(remote, rules);
        if (pushed) urls.push(pushed);
      }
    }
    await enforceGitRemotes(urls);
  }

  /**
   * For a push to a repository on this machine, the receive-pack command to
   * run there: git clears our `-c` for the receiving side, so it gets the
   * same switch-offs and the receiving repository's own program-running
   * settings neutralised (a filter would run when
   * `receive.denyCurrentBranch=updateInstead` checks the files out). Refused
   * when the receiving repository sets a key that cannot be neutralised.
   * Null for a push that leaves this machine.
   */
  private async localReceivePack(remote: string, cwd: string): Promise<string | null> {
    const named = /^[A-Za-z0-9._-]+$/.test(remote) && gitRemoteTarget(remote) === null;
    const urls = named
      ? (await this.git(['remote', 'get-url', '--push', '--all', '--', remote], cwd).catch(() => remote)).split('\n').map((u) => u.trim()).filter(Boolean)
      : [remote];
    // The egress parser refuses whitespace, but git accepts local paths
    // containing it. Such receivers still need their own config guards.
    const local = urls.filter((url) => {
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1]?.toLowerCase();
      if (scheme) return scheme === 'file';
      const colon = url.indexOf(':');
      const slash = url.indexOf('/');
      return colon < 0 || (slash >= 0 && slash < colon);
    });
    if (!local.length) return null;
    const neutralize: string[] = [];
    for (const url of local) {
      const path = /^file:\/\//i.test(url) ? fileURLToPath(url) : resolve(cwd, url);
      const entries = await this.repoConfig(path).catch((err: unknown) => {
        toolLogger.debug({ err: (err as Error).message, path }, 'The receiving repository\'s config could not be read; hooks stay off');
        return [] as ConfigEntry[];
      });
      const refused = refusedKeys(entries);
      if (refused.length) throw new ToolNotExecutedError('git', `The repository this pushes into sets ${refused.join(', ')}, which would run a program on the host; not pushed.`);
      neutralize.push(...neutralizingArgs(entries));
    }
    return ['git', ...HARDENED_GIT, ...neutralize, 'receive-pack'].map(shellQuote).join(' ');
  }

  /**
   * A git run that contacts a remote. Under an active egress policy:
   * repository-level configuration that could reroute it or run a command
   * (a proxy, `uploadpack`/`receivepack`, `core.sshCommand`, a credential
   * helper, filters, includes, `http.curloptResolve`, rebase and signing
   * settings, ...) is refused — the model can write `.git/config`. Hooks,
   * editors and `ext::` are off for every git run already (`git`). The
   * operator's own global and system configuration is left alone.
   */
  private async networkGit(args: string[], cwd: string, inRepo = true): Promise<string> {
    if (!currentEgressSubject() || !egressPolicyActive(activeEgressPolicy())) return this.git(args, cwd);
    // A clone reads no repository's configuration but the new one's.
    if (inRepo) {
      const risky = reroutingRepoConfig(await this.repoConfig(cwd));
      if (risky.length) {
        throw new ToolNotExecutedError('git', `The repository's own git configuration sets ${risky.join(', ')}, which can reroute this ${args[0]} around the egress policy or run a command; it was not run. Remove those keys from .git/config.`);
      }
    }
    return this.git(args, cwd);
  }

  /** The agent a git call runs for: every handler runs inside it (see `registerTool`). */
  private readonly caller = new AsyncLocalStorage<AgentContext>();

  /**
   * Every handler runs with its agent context in `caller`, so `git` can tell
   * a space session from a personal one without threading the context
   * through every handler.
   */
  protected override registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>,
    options?: ToolExecutionOptions,
  ): void {
    super.registerTool(name, description, parameters, (args, context) => this.caller.run(context, () => execute(args, context)), options);
  }

  /**
   * How one git run is spawned. git authenticates through the credential
   * helper and ssh-agent, not through the environment, so it needs none of
   * the secrets the harness holds. In a space (coworking §9.5) it never uses
   * the host's identity: the run's own tool home (only the space's GitHub
   * connection in it), the host's agent and askpass variables removed, and
   * every configured credential helper reset on the command line. Public
   * for the tests; the caller disposes of `home`.
   */
  async spawnPlan(args: string[]): Promise<{ args: string[]; env: Record<string, string>; home: SpaceToolHome | null }> {
    const context = this.caller.getStore();
    if (!context?.space) return { args, env: buildChildEnv(), home: null };
    const home = await openSpaceToolHome({ ...context, space: context.space });
    return { args: [...home.gitArgs, ...args], env: withToolHome(buildChildEnv(), home), home };
  }

  /** `spawnPlan` as the agent `context` would get it (tests). */
  spawnPlanFor(context: AgentContext, args: string[]): ReturnType<GitTool['spawnPlan']> {
    return this.caller.run(context, () => this.spawnPlan(args));
  }

  /**
   * Every git run of this tool. git runs on the host, outside the shell
   * sandbox, so nothing the repository says may make it run a program: the
   * model (or a sandboxed command) can write `.git/config` and `.git/hooks`.
   * Hooks, fsmonitor, pagers, editors and `ext::` are switched off on the
   * command line (`HARDENED_GIT`); the repository's own program-running
   * settings are neutralised with `-c`, the operator's values put back
   * (src/tools/git/repo-config.ts); the few that cannot be neutralised refuse
   * the action. The operator's global and system configuration is trusted.
   */
  private async git(args: string[], cwd: string): Promise<string> {
    const entries = await this.repoConfig(cwd);
    const refused = refusedKeys(entries);
    if (refused.length) {
      throw new ToolNotExecutedError('git', `The repository's own git configuration sets ${refused.join(', ')}, which would run a program on the host outside the sandbox and cannot be switched off; the git tool does not run in it. Remove those keys from .git/config (or run git through the sandboxed shell).`);
    }
    return this.runGit([...HARDENED_GIT, ...neutralizingArgs(entries), ...args], cwd);
  }

  /**
   * The configuration git will read in `cwd`, with scopes. Older git without
   * `--show-scope` (before 2.26): the repository's own file with includes,
   * and its worktree file when `extensions.worktreeConfig` is set — refused
   * when that cannot be read.
   */
  private async repoConfig(cwd: string): Promise<ConfigEntry[]> {
    try {
      return parseConfigListing(await this.runGit([...HARDENED_GIT, 'config', '--list', '--show-scope'], cwd));
    } catch (err) {
      toolLogger.debug({ err: (err as Error).message }, 'git config --show-scope unavailable; reading the repository\'s own config files');
    }
    const scoped = (scope: string, out: string) => parseConfigListing(out.split('\n').filter(Boolean).map((line) => `${scope}\t${line}`).join('\n'));
    const local = scoped('local', await this.runGit([...HARDENED_GIT, 'config', '--local', '--includes', '--list'], cwd).catch(() => ''));
    if (local.some((e) => e.key === 'extensions.worktreeconfig' && e.value.toLowerCase() === 'true')) {
      const worktree = await this.runGit([...HARDENED_GIT, 'config', '--worktree', '--includes', '--list'], cwd).catch(() => null);
      if (worktree === null) throw new ToolNotExecutedError('git', 'This repository has per-worktree configuration that this git cannot list; the git tool does not run in it.');
      return [...local, ...scoped('worktree', worktree)];
    }
    return local;
  }

  private async runGit(args: string[], cwd: string): Promise<string> {
    const caller = this.caller.getStore();
    if (caller && executionEnvironmentFor(caller)) {
      const home = environmentToolHome(caller);
      try {
        const directory = resolveEnvironmentCwd(cwd, caller)!;
        const command = ['git', ...(home?.gitArgs ?? []), ...args].map(quoteRuntimeArg).join(' ');
        const credentials = await environmentCredentialOptions(caller, { ...environmentShellOptions(caller), timeout: 120000, signal: getExecutionSignal(caller), env: home?.env, ...(home ? { unsetEnv: HOST_IDENTITY_ENV } : {}), extraReadWrite: [...(environmentShellOptions(caller).extraReadWrite ?? []), ...(home ? [home.dir] : [])] });
        let result;
        try { result = credentials.mask(await shellOperationsFor(caller, new LocalShellOperations()).exec(command, directory, credentials.options)); }
        catch (error) { throw credentials.maskError(error); }
        if (result.exitCode !== 0 || result.killed) throw new Error(result.stderr || 'Git did not complete');
        return result.stdout.trim();
      } finally { home?.dispose(); }
    }
    const plan = await this.spawnPlan(args);
    return new Promise((resolve, reject) => {
      const child = spawn('git', plan.args, { cwd, env: plan.env });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      child.on('error', (err) => { plan.home?.dispose(); reject(err); });

      child.on('close', (code) => {
        plan.home?.dispose();
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });
    });
  }

  private parseStatus(output: string): {
    branch: string;
    ahead?: number;
    behind?: number;
    staged: string[];
    modified: string[];
    untracked: string[];
  } {
    const lines = output.split('\n').filter(Boolean);
    const result = {
      branch: '',
      staged: [] as string[],
      modified: [] as string[],
      untracked: [] as string[],
    };

    for (const line of lines) {
      if (line.startsWith('##')) {
        const match = line.match(/## ([^\s.]+)(?:\.\.\.(\S+?)(?:\s+\[ahead (\d+)(?:, behind (\d+))?\])?)?\s*$/);
        if (match) {
          result.branch = match[1];
          if (match[3]) (result as any).ahead = parseInt(match[3]);
          if (match[4]) (result as any).behind = parseInt(match[4]);
        }
      } else {
        const status = line.substring(0, 2);
        const file = line.substring(3);

        if (status[0] !== ' ' && status[0] !== '?') result.staged.push(file);
        if (status[1] === 'M') result.modified.push(file);
        if (status === '??') result.untracked.push(file);
      }
    }

    return result;
  }
}

export const gitTool = new GitTool();

/** `-c` settings for a git run that contacts a remote under an egress policy: no hooks, no `ext::` transport, no fsmonitor. */
/** Leading options on every git run of the tool (src/security/git-hardening.ts). */
const HARDENED_GIT = HARDENED_GIT_ARGS;

/**
 * Repository-scope keys that reroute a network run (under an egress policy):
 * a proxy, an address override, another transport or helper, rebase and
 * signing settings. Program-running keys are neutralised for every run
 * already (src/tools/git/repo-config.ts).
 */
const REROUTING_KEY = /^(?:https?\.proxy|http\..+\.proxy|http\.(?:.+\.)?curloptresolve|remote\..+\.(?:proxy|proxyauthmethod|vcs)|core\.gitproxy|protocol\..+|ssh\.variant|fetch\.recursesubmodules|rebase\..+|push\.gpgsign)$/;

/** The rerouting keys set at repository (local/worktree) scope. */
export function reroutingRepoConfig(entries: ConfigEntry[]): string[] {
  return [...new Set(entries.filter((e) => (e.scope === 'local' || e.scope === 'worktree') && REROUTING_KEY.test(e.key)).map((e) => e.key))];
}

/**
 * `url` rewritten by the longest matching `url.<base>.pushInsteadOf <prefix>`
 * rule (`git config --get-regexp` lines), as git does for a push to a URL;
 * null when none matches.
 */
export function rewriteInsteadOf(url: string, rules: string[]): string | null {
  let best: { base: string; prefix: string } | null = null;
  for (const line of rules) {
    const m = /^url\.(.+)\.pushinsteadof\s+(.*)$/i.exec(line);
    if (!m || !url.startsWith(m[2])) continue;
    if (!best || m[2].length > best.prefix.length) best = { base: m[1], prefix: m[2] };
  }
  return best ? best.base + url.slice(best.prefix.length) : null;
}

/** A user-supplied git positional: a non-empty string that git cannot read as an option. */
export function gitArgument(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolNotExecutedError('git', `Missing ${what}`);
  if (value.startsWith('-')) throw new ToolNotExecutedError('git', `The ${what} must not start with "-" (it would be read as a git option)`);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ToolNotExecutedError('git', `The ${what} contains a control character`);
  return value;
}

/** A branch or ref name, by `git check-ref-format`'s rules (simplified, stricter). */
export function gitRefName(value: unknown, what: string): string {
  const name = gitArgument(value, what);
  if (name === '@' || /\.\.|@\{|\/\/|\/\.|[\s~^:?*[\\]|^\/|\/$|\.$|\.lock$/.test(name)) throw new ToolNotExecutedError('git', `Not a valid ${what}: ${name}`);
  return name;
}

/**
 * A branch or refspec for pull/push: `name`, or `[+]src:dst` with both sides
 * valid ref names (`HEAD:main`, `+feature:feature`).
 */
export function gitRefspec(value: unknown): string {
  const spec = gitArgument(value, 'branch');
  const force = spec.startsWith('+') ? '+' : '';
  const body = spec.slice(force.length);
  const sides = body.split(':');
  if (sides.length > 2) throw new ToolNotExecutedError('git', `Not a valid refspec: ${spec}`);
  for (const side of sides) gitRefName(side, 'branch');
  return spec;
}

/** A remote: a remote name, or a URL / path for git to resolve. */
export function gitRemoteArgument(value: unknown): string {
  return gitArgument(value, 'remote');
}

/** A positive integer argument (`-<count>`, `--depth`). */
export function gitCount(value: unknown, what: string): string {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new ToolNotExecutedError('git', `The ${what} must be a positive integer`);
  return String(n);
}
