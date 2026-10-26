import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getConfig } from '@/config';

export interface ShellSshAgent {
  socket: string;
  knownHosts?: string;
}

/** Only the operator's inherited socket is eligible; callers cannot supply a host path. */
export function shellSshAgent(disabled: boolean): ShellSshAgent | undefined {
  if (disabled || !getConfig().security.shellSshAgent) return undefined;
  const socket = process.env.SSH_AUTH_SOCK;
  if (!socket || !isAbsolute(socket)) throw new Error('SSH agent forwarding is enabled, but SSH_AUTH_SOCK is missing or not absolute. Start Octipus with the agent environment.');
  try {
    if (!statSync(socket).isSocket()) throw new Error('path is not a Unix socket');
  } catch (error) {
    throw new Error(`SSH agent forwarding cannot use SSH_AUTH_SOCK: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const knownHosts = join(homedir(), '.ssh', 'known_hosts');
  try {
    if (!statSync(knownHosts).isFile()) throw new Error('known_hosts is not a regular file');
    return { socket, knownHosts };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { socket };
    throw error;
  }
}
