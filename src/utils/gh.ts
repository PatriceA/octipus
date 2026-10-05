/**
 * One `gh` runner for everything that shells out to the GitHub CLI: the
 * GitHub tool and the heartbeat probe. gh's own credentials are kept in the
 * child environment; everything else the harness holds is not gh's business
 * (`buildChildEnv`). An optional timeout kills a hung `gh` — the tool runs
 * without one (an interactive turn can wait), a background probe cannot.
 *
 * Inside a space (coworking §9.5) the caller passes `configDir` (an empty
 * per-space `GH_CONFIG_DIR`) and the space's own `token`, if it has one: the
 * host's gh login and GH tokens are then never used.
 */
import { spawn } from 'node:child_process';
import { buildChildEnv } from '@/security/child-env';

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
  /** `GH_CONFIG_DIR` for this run (a space's empty one), instead of the host's. */
  configDir?: string;
}

/** The environment of one `gh` run. Exported for the tests. */
export function ghEnv(opts: Pick<RunGhOptions, 'token' | 'configDir'> = {}): Record<string, string> {
  const own = opts.token !== undefined || opts.configDir !== undefined;
  return buildChildEnv({
    ...(opts.configDir ? { GH_CONFIG_DIR: opts.configDir } : {}),
    ...(opts.token ? { GH_TOKEN: opts.token } : {}),
  }, { keep: own ? [] : GH_KEEP_ENV });
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
