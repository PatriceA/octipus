import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SpaceToolHome } from './space-tool-env';
import { executionEnvironmentFor, type EnvironmentCaller } from './execution-environments';

/** A stable private home for isolated identities. Never copy the host's login files. */
export function environmentToolHome(caller: EnvironmentCaller): SpaceToolHome | null {
  const profile = executionEnvironmentFor(caller);
  if (!profile || profile.backend === 'ssh' || (profile.backend === 'host' && profile.hostIdentity)) return null;
  const dir = join(homedir(), '.octipus', 'runtime-homes', profile.userId, profile.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, env: { HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, '.config'), GH_CONFIG_DIR: join(dir, '.config', 'gh'),
    GIT_CONFIG_GLOBAL: join(dir, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    gitArgs: ['-c', `core.sshCommand=ssh -F ${JSON.stringify(join(dir, '.ssh/config'))} -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes`],
    dispose() { /* Persistent environment home; owner manages its connected identities. */ } };
}
