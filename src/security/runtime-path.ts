import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, isAbsolute, relative } from 'node:path';

/** Preserve the host PATH and expose supported user-installed toolchains. */
export function runtimePath(path = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return path;
  return [...new Set([...path.split(delimiter).filter(Boolean), join(homedir(), '.local/bin'),
    join(homedir(), '.npm-global/bin'), join(homedir(), '.local/go/bin'), join(homedir(), 'go/bin')])].join(delimiter);
}

/** Public browser runtimes shared by all sandbox jobs; never expose all ~/.cache. */
export function browserRuntimePaths(): string[] {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return [...new Set([join(cache, 'ms-playwright'), ...(configured && isAbsolute(configured) ? [configured] : [])])];
}


/** Sandboxed POSIX commands have a private /tmp; Windows uses its own temp root. */
export function packageStorePath(): string {
  return process.platform === 'win32' ? join(tmpdir(), 'octipus-pnpm-store') : '/tmp/octipus-pnpm-store';
}

/** Distinguish a missing browser revision from host/sandbox visibility problems. */
export function browserRuntimeDiagnostic(stderr: string): string | undefined {
  const expected = /Executable doesn't exist at ([^\r\n]+)/.exec(stderr)?.[1]?.trim();
  if (!expected || !isAbsolute(expected)) return undefined;
  const cache = browserRuntimePaths().find(root => { const rel = relative(root, expected); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); });
  if (!cache) return 'Browser executable is outside the shared cache. Configure a server-side absolute PLAYWRIGHT_BROWSERS_PATH and provision the required revision there once.';
  if (existsSync(expected)) return 'The required browser executable exists on the host but the job could not access it. Check sandbox cache mounts and executable permissions; do not download another copy.';
  if (!existsSync(cache)) return 'The shared browser cache is absent on the host. Configure and provision it once before retrying the job.';
  return 'The shared browser cache exists, but this project requires a browser revision that is missing on the host. Provision that compatible revision once through operator maintenance; no per-job download was attempted.';
}

/** Mount downloaded runtimes only, never browser profiles/cookies placed alongside them. */
export function browserRuntimeMounts(): string[] {
  return browserRuntimePaths().flatMap(root => {
    try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(?:chromium(?:_headless_shell|_tip_of_tree)?|firefox|webkit|ffmpeg|winldd)-[0-9]+$/.test(entry.name)).map(entry => join(root, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  });
}
