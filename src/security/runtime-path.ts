import { homedir, tmpdir } from 'node:os';
import { delimiter, join, isAbsolute } from 'node:path';

/** Preserve the host PATH and expose supported user-installed toolchains. */
export function runtimePath(path = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return path;
  return [...new Set([...path.split(delimiter).filter(Boolean), join(homedir(), '.local/bin'),
    join(homedir(), '.npm-global/bin'), join(homedir(), '.local/go/bin'), join(homedir(), 'go/bin')])].join(delimiter);
}

/** Public browser runtimes needed by host-service gates; never expose all ~/.cache. */
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
