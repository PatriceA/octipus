import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, isAbsolute, relative, parse } from 'node:path';

/** Installed Android toolchains only; never the adjacent .android credentials. */
export function androidSdkPaths(): string[] {
  const defaultSdk = process.platform === 'darwin' ? join(homedir(), 'Library/Android/sdk')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Android/Sdk')
    : join(homedir(), 'Android/Sdk');
  return [...new Set([process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, defaultSdk]
    .filter((path): path is string => !!path && isAbsolute(path)))].filter(path => {
      try {
        const root = realpathSync(path);
        // An invalid environment setting must not expose the user's home or /.
        const homeRelative = relative(root, homedir());
        if (homeRelative === '' || !homeRelative.startsWith('..') && !isAbsolute(homeRelative)) return false;
        return ['platforms', 'build-tools'].every(directory => statSync(join(root, directory)).isDirectory());
      } catch { return false; }
    });
}

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

/** Read-only program exposure, never the adjacent home/configuration directories. */
export function installedProgramPaths(searchPath: string): string[] {
  const directories = new Set<string>();
  const targets = new Set<string>();
  const configuredPrivate = [...['.ssh', '.kube', '.aws', '.config', '.octipus', '.gnupg'].map(name => join(homedir(), name)),
    ...(process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? [process.env.XDG_CONFIG_HOME] : [])];
  const privateRoots = configuredPrivate.flatMap(root => { try { return [root, realpathSync(root)]; } catch { return [root]; } });
  const privatePath = (file: string) => privateRoots.some(root => { const rel = relative(root, file); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); });
  for (const entry of searchPath.split(delimiter).filter(isAbsolute)) {
    try {
      const directory = realpathSync(entry);
      const toHome = relative(directory, homedir());
      if (directory === resolveFilesystemRoot(directory) || toHome === '' || !toHome.startsWith('..') && !isAbsolute(toHome) || privatePath(directory) || !statSync(directory).isDirectory()) continue;
      directories.add(directory);
      for (const name of readdirSync(directory).slice(0, 8192)) {
        try { const file = join(directory, name); accessSync(file, constants.X_OK);
          const target = realpathSync(file); if (target !== file && !privatePath(target) && statSync(target).isFile()) targets.add(target);
        } catch { /* An inaccessible PATH entry is not an available program. */ }
      }
    } catch { /* Nonexistent PATH directories are ignored by process lookup too. */ }
  }
  return [...directories, ...targets];
}
function resolveFilesystemRoot(directory: string): string { return parse(directory).root; }
