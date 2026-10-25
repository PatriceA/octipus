import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Preserve the host PATH and expose supported user-installed toolchains. */
export function runtimePath(path = process.env.PATH ?? ''): string {
  if (process.platform === 'win32') return path;
  return [...new Set([...path.split(delimiter).filter(Boolean), join(homedir(), '.local/bin'),
    join(homedir(), '.npm-global/bin'), join(homedir(), '.local/go/bin'), join(homedir(), 'go/bin')])].join(delimiter);
}
