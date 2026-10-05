/**
 * The environment of tools run inside a space (docs/plans/coworking-spec.md
 * §9.5): space sessions never act with the host's GitHub or git identity,
 * nor with another member's.
 *
 * The shell already strips `GH_TOKEN` / `GITHUB_TOKEN` (`child-env.ts`). What
 * is left of the host's identity lives under `HOME` (`~/.config/gh/hosts.yml`,
 * `~/.gitconfig` credential helpers, `~/.git-credentials`), in the SSH agent
 * (`SSH_AUTH_SOCK`) and in variables pointing git at a helper or another
 * config (`GIT_ASKPASS`, `GIT_SSH_COMMAND`, `GIT_CONFIG_*`).
 *
 * So in a space every git, shell, `gh` and CLI-agent run gets a tool home of
 * its own: a fresh temporary directory (0700), removed when the run ends,
 * that `HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR` and git's global config
 * point at. It holds only what the space's GitHub connector provides, when an
 * owner connected one and the member's role may have the agent write: a `gh`
 * login (`hosts.yml`) and a git credential helper for github.com, both with
 * the space's token, plus the member's name as git author. Nothing in it outlives the run, so one member's run cannot plant a
 * login, a hook or an alias that another member's run picks up.
 *
 * The host's identity variables are removed (`HOST_IDENTITY_ENV`), git reads
 * no system config, prompts for nothing, resets every credential helper the
 * repository or the host configured (`credential.helper=` via
 * `GIT_CONFIG_COUNT`), and reaches SSH remotes without the host's keys or
 * agent. Residual risk (docs/SPACES.md): without the process sandbox a
 * command still runs as the server's OS user and can read the host's files
 * by absolute path; the sandbox is what hides them.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Host variables that carry a git, SSH or GitHub identity, or point git at
 * a helper or config of the host's. Removed from every space run, whatever
 * the caller's own `env` says.
 */
export const HOST_IDENTITY_ENV: readonly string[] = [
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
  'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
];

/** What the space's connectors provide to one run. */
export interface SpaceToolSeed {
  /** The space's GitHub token, when an owner connected GitHub to the space. */
  githubToken: string | null;
  /** The member the run is for, as git author. */
  author?: { name: string; email: string };
}

/** One run's tool home. */
export interface SpaceToolHome {
  /** The directory (`HOME`). */
  readonly dir: string;
  /** Laid over the run's environment last (after `HOST_IDENTITY_ENV` is removed). */
  readonly env: Readonly<Record<string, string>>;
  /** `git -c` arguments repeating the credential reset, for a git run (they win over any config file). */
  readonly gitArgs: readonly string[];
  /** Remove the directory. Idempotent. */
  dispose(): void;
}

/** A git config value that names a file of the tool home; refuses a path a shell would split. */
function shellPath(path: string): string {
  if (/['\n\r]/.test(path)) throw new Error(`space tool home: unusable path ${JSON.stringify(path)}`);
  return `'${path}'`;
}

/** A git config string in double quotes. */
function gitQuoted(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r]/g, ' ')}"`;
}

/**
 * Create the tool home of one run in `workspaceId`, seeded with `seed`. The
 * caller disposes of it when the run ends.
 */
export function createSpaceToolHome(workspaceId: string, seed: SpaceToolSeed): SpaceToolHome {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
    throw new Error(`space tool home: not a space id: ${workspaceId}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'octipus-space-home-'));
  const configHome = join(dir, '.config');
  const ghDir = join(configHome, 'gh');
  const gitconfig = join(dir, '.gitconfig');
  const helpers: Array<[string, string]> = [['credential.helper', '']];
  try {
    mkdirSync(ghDir, { recursive: true, mode: 0o700 });
    if (seed.githubToken) {
      const token = seed.githubToken.trim();
      if (!token || /\s/.test(token)) throw new Error('space tool home: the space\'s GitHub token is malformed');
      const tokenFile = join(dir, '.github-token');
      writeFileSync(tokenFile, token, { mode: 0o600 });
      writeFileSync(join(ghDir, 'hosts.yml'), `github.com:\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n`, { mode: 0o600 });
      helpers.push(['credential.https://github.com.helper',
        `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$(cat ${shellPath(tokenFile)})"; }; f`]);
    }
    const author = seed.author ? `[user]\n\tname = ${gitQuoted(seed.author.name)}\n\temail = ${gitQuoted(seed.author.email)}\n` : '';
    writeFileSync(gitconfig, author, { mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const env: Record<string, string> = {
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: configHome,
    GH_CONFIG_DIR: ghDir,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // SSH remotes: no host keys, no agent, no ~/.ssh/config (ssh reads the
    // passwd home, not HOME), never a prompt.
    GIT_SSH_COMMAND: 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes',
    GIT_CONFIG_COUNT: String(helpers.length),
  };
  helpers.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  let disposed = false;
  return {
    dir,
    env,
    gitArgs: helpers.flatMap(([key, value]) => ['-c', `${key}=${value}`]),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * `env` for a run in the space: the host's identity variables removed (also
 * when the caller set them), then the tool home's laid over it.
 */
export function withToolHome(env: Record<string, string>, home: SpaceToolHome): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (HOST_IDENTITY_ENV.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...home.env };
}

/** The agent a space run is for (structural, so this module stays free of `core`). */
export interface SpaceRunContext {
  userId?: string | null;
  workspaceId?: string | null;
  space?: { workspaceId: string; role: string; scope: unknown } | null;
}

/**
 * The tool home of one run of `context`'s agent in its space: the space's
 * GitHub token when an owner connected one and the member's role may have
 * the agent write (a commenter's run gets none: the GitHub tool's reads pass
 * the token to `gh` itself), and the member as git author.
 */
export async function openSpaceToolHome(context: SpaceRunContext & { space: NonNullable<SpaceRunContext['space']> }): Promise<SpaceToolHome> {
  const [{ agentPrincipal }, { spaceGithubToken }, { can }, { userRepository }] = await Promise.all([
    import('./principal'), import('@/core/spaces/connectors'), import('./space-access'), import('@/db/repositories/user-repository'),
  ]);
  const principal = agentPrincipal(context as Parameters<typeof agentPrincipal>[0]);
  const githubToken = can(principal.spaceRole, 'run_agent_write') ? await spaceGithubToken(principal) : null;
  const user = await userRepository.findById(principal.userId);
  const author = user ? { name: user.username, email: user.email ?? `${user.username}@users.octipus.invalid` } : undefined;
  return createSpaceToolHome(context.space.workspaceId, { githubToken, ...(author ? { author } : {}) });
}
