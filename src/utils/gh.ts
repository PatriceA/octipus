/**
 * One `gh` runner for everything that shells out to the GitHub CLI: the
 * GitHub tool and the heartbeat probe. gh's own credentials are kept in the
 * child environment; everything else the harness holds is not gh's business
 * (`buildChildEnv`). An optional timeout kills a hung `gh` — the tool runs
 * without one (an interactive turn can wait), a background probe cannot.
 *
 * Inside a space (coworking §9.5) the caller passes the run's `toolHome` (a
 * fresh directory holding only the space connector's login) and the space's
 * own `token`: the host's gh login, GH tokens, SSH agent and git helpers are
 * then never used.
 */
import { spawn } from 'node:child_process';
import { buildChildEnv } from '@/security/child-env';
import { type SpaceToolHome, withToolHome } from '@/security/space-tool-env';

const GH_KEEP_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

export interface RunGhOptions {
  timeoutMs?: number;
  /**
   * Exit codes that still resolve with stdout. `gh pr checks` exits 8 while
   * checks are pending and 1 when one failed, and in both cases its JSON is
   * the answer the caller wanted, not an error.
   */
  acceptExitCodes?: number[];
  /**
   * The GitHub token to act with (`GH_TOKEN`), instead of the host's. Set,
   * the host's GH token variables are not passed on.
   */
  token?: string;
  /** A space run's tool home (`space-tool-env.ts`): `HOME`, `GH_CONFIG_DIR` and git's config there, the host's identity removed. */
  toolHome?: SpaceToolHome;
}

/** The environment of one `gh` run. Exported for the tests. */
export function ghEnv(opts: Pick<RunGhOptions, 'token' | 'toolHome'> = {}): Record<string, string> {
  const own = opts.token !== undefined || opts.toolHome !== undefined;
  const env = buildChildEnv({}, { keep: own ? [] : GH_KEEP_ENV });
  const out = opts.toolHome ? withToolHome(env, opts.toolHome) : env;
  return opts.token ? { ...out, GH_TOKEN: opts.token } : out;
}

export function runGh(args: string[], opts: RunGhOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env: ghEnv(opts) });
    let stdout = '';
    let stderr = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`gh timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || (code !== null && opts.acceptExitCodes?.includes(code))) resolve(stdout);
      else reject(new Error(stderr.trim() || `gh command failed with code ${code}`));
    });
  });
}
