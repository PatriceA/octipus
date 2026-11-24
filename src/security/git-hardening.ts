/**
 * Settings that keep git from running a program a repository asks for:
 * the model, or a command in the shell sandbox, can write `.git/config` and
 * `.git/hooks` in the workspace, while the git and github tools run git on
 * the host, outside the sandbox (docs/EGRESS-POLICY.md#git).
 *
 * Applied as `-c` options by the git tool and as `GIT_CONFIG_COUNT`
 * environment entries for the git that `gh` starts; both outrank every config
 * file. Repository-scope settings that cannot be switched off this way are
 * refused by the git tool (`programRunningRepoConfig` in src/tools/git).
 *
 * `diff.external` cannot be unset with `-c` (an empty value is a program
 * named ""): the git tool's diff passes `--no-ext-diff` instead.
 */
const NULL_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const HARDENED_GIT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['core.hooksPath', NULL_PATH],
  ['core.fsmonitor', 'false'],
  ['core.pager', 'cat'],
  ['core.editor', 'true'],
  ['sequence.editor', 'true'],
  ['protocol.ext.allow', 'never'],
];

/** The settings as git's leading options (`--no-pager -c k=v ...`). */
export const HARDENED_GIT_ARGS: readonly string[] = ['--no-pager', ...HARDENED_GIT_SETTINGS.flatMap(([key, value]) => ['-c', `${key}=${value}`])];

/**
 * `env` with the settings appended as `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
 * after any entries it already has (a space's tool home sets some).
 */
export function withHardenedGitEnv(env: Record<string, string>): Record<string, string> {
  const start = Number(env.GIT_CONFIG_COUNT ?? '0');
  const base = Number.isInteger(start) && start >= 0 ? start : 0;
  const out: Record<string, string> = { ...env, GIT_PAGER: 'cat' };
  HARDENED_GIT_SETTINGS.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(base + HARDENED_GIT_SETTINGS.length);
  return out;
}
