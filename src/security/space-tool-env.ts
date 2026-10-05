/**
 * The environment of tools run inside a space (docs/plans/coworking-spec.md
 * §9.5): space sessions never act with the host's GitHub identity.
 *
 * The shell already strips `GH_TOKEN` / `GITHUB_TOKEN` (`child-env.ts`); what
 * is left is the host's `gh` login under `HOME` (`~/.config/gh/hosts.yml`)
 * and, for CLI agents, every other login kept there (git credentials, cloud
 * CLIs). In a space the shell, `runGh` and CLI agents run with
 * `GH_CONFIG_DIR` — and, for CLI agents, `HOME` and `XDG_CONFIG_HOME` — at a
 * per-space directory created empty under the space's root (removed with the
 * space by purge). The space's own GitHub identity, when an owner connected
 * one, reaches `gh` as `GH_TOKEN` from the GitHub tool only.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spaceDirectories } from './workspace-fs';

/** `<space root>/tool-home`, created (0700) with an empty `gh` config directory in it. */
export function spaceToolHome(workspaceId: string): string {
  const home = join(spaceDirectories(workspaceId).root, 'tool-home');
  mkdirSync(join(home, '.config', 'gh'), { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The variables a tool in `workspaceId` runs with, laid over its environment
 * last (a caller's own `env` cannot point them back at the host). `home`
 * also moves `HOME` and `XDG_CONFIG_HOME` (CLI agents).
 */
export function spaceToolEnv(workspaceId: string, opts: { home?: boolean } = {}): Record<string, string> {
  const home = spaceToolHome(workspaceId);
  const env: Record<string, string> = { GH_CONFIG_DIR: join(home, '.config', 'gh') };
  if (opts.home) {
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = join(home, '.config');
  }
  return env;
}
