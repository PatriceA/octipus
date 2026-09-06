/**
 * One `gh` runner for everything that shells out to the GitHub CLI: the
 * GitHub tool and the heartbeat probe. gh's own credentials are kept in the
 * child environment; everything else the harness holds is not gh's business
 * (`buildChildEnv`). An optional timeout kills a hung `gh` — the tool runs
 * without one (an interactive turn can wait), a background probe cannot.
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
}

export function runGh(args: string[], opts: RunGhOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env: buildChildEnv(undefined, { keep: GH_KEEP_ENV }) });
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
