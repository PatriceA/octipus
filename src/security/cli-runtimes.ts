import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { getConfig } from '@/config';
import { runtimePath } from './runtime-path';

export interface CliRuntime { name: string; path: string; resolvedPath: string }
export function inspectCliRuntime(path: string): CliRuntime {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('Choose an absolute executable path on the Octipus server.');
  const name = basename(path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(name)) throw new Error('Unsupported executable name.');
  const resolvedPath = realpathSync(path);
  if (!statSync(resolvedPath).isFile()) throw new Error('Choose an executable file, not a directory.');
  accessSync(resolvedPath, constants.X_OK);
  return { name, path, resolvedPath };
}
/** Discovery reads directory entries and file metadata; it never executes a command. */
export function discoverCliRuntimes(path = runtimePath()): CliRuntime[] {
  const found = new Map<string, CliRuntime>();
  for (const dir of path.split(delimiter).filter(isAbsolute)) {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      if (found.has(name)) continue;
      try { found.set(name, inspectCliRuntime(join(dir, name))); } catch { /* Not an executable. */ }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function approvedCliRuntimes(): CliRuntime[] {
  let configured: CliRuntime[];
  try { configured = getConfig().security.cliRuntimes ?? []; } catch { return []; }
  return configured.flatMap(entry => {
    try {
      const current = inspectCliRuntime(entry.path);
      if (current.name !== entry.name || current.resolvedPath !== entry.resolvedPath) throw new Error('Executable target changed');
      return [current];
    } catch {
      // A removed tool must not block unrelated commands. Settings displays its
      // unavailable state; no extra executable is exposed until it is reapproved.
      return [];
    }
  });
}
