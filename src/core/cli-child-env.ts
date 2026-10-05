/**
 * Minimal env for a spawned vendor CLI (C6). Only PATH/HOME/locale/TERM, the
 * CLI's own auth var, and per-tool overrides — NOT the server's full env
 * (DB creds, every API key, internal secrets).
 *
 * Shared by the CLI agent worker and the one-shot `CLIProvider.complete()`
 * path; the latter used to spawn with the whole `process.env`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '@/config';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { CLIToolConfig } from '@/models/providers/cli-provider';
import { type SpaceToolHome, withToolHome } from '@/security/space-tool-env';

export function buildChildEnv(tool: CLIToolConfig, toolEnv?: Record<string, string>, inheritApiKeys = false): Record<string, string> {
  const base: Record<string, string> = {};
  const pass = (k: string) => { const v = process.env[k]; if (v != null) base[k] = v; };
  // Core shell/runtime env every CLI needs to find its binary + config dir.
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TZ', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'CODEX_HOME']) pass(k);
  // Windows equivalents.
  for (const k of ['SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP']) pass(k);
  // Non-secret Windows system vars vendor CLIs probe: Claude Code needs
  // CLAUDE_CODE_GIT_BASH_PATH / ProgramFiles to find Git Bash, Node's
  // os.homedir()/userInfo() fall back to HOMEDRIVE+HOMEPATH/USERNAME.
  for (const k of ['CLAUDE_CODE_GIT_BASH_PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'CommonProgramFiles',
    'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'windir', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS']) pass(k);
  // Locale (LC_ALL, LC_CTYPE, …).
  for (const k of Object.keys(process.env)) if (k.startsWith('LC_')) pass(k);
  // The CLI's own auth vars — scoped per provider so codex doesn't see the
  // Anthropic key, etc.
  const authByProvider: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    openai: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'],
    mistral: ['MISTRAL_API_KEY'],
  };
  if (inheritApiKeys) for (const k of authByProvider[tool.modelProvider] || []) pass(k);
  if (tool.modelProvider === 'anthropic') pass('CLAUDE_CODE_OAUTH_TOKEN');
  // Per-tool overrides (e.g. vibe's ephemeral VIBE_HOME).
  Object.assign(base, toolEnv || {});
  // Never let the child think it's running inside Claude Code itself.
  delete base.CLAUDECODE;
  return base;
}

/**
 * Whose CLI credentials a run uses (coworking spec §8.5): `null` for an install
 * CLI row (the server's own login, today's behaviour), else the owner of a
 * personal CLI row and the token they stored.
 */
export interface CliCredentialOwner {
  userId: string;
  token: string;
}

/** Every auth variable a vendor CLI reads — stripped from a personal run, whatever the server holds. */
const SERVER_AUTH_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'MISTRAL_API_KEY',
];

/** Vendors a personal CLI row may use: the ones whose CLI reads one plain token variable. */
export const PERSONAL_CLI_VENDORS: readonly CLIToolConfig['modelProvider'][] = ['anthropic', 'openai', 'google', 'mistral'];

/** The variable a personal token goes into, per CLI vendor. */
function authVarFor(tool: CLIToolConfig, token: string): string {
  switch (tool.modelProvider) {
    case 'anthropic': return token.startsWith('sk-ant-api') ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
    case 'openai': return 'OPENAI_API_KEY';
    case 'google': return 'GEMINI_API_KEY';
    case 'mistral': return 'MISTRAL_API_KEY';
    default: throw new Error(`${tool.name} cannot run on a personal credential`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The per-user CLI home: `<workspace.rootPath>/users/{id}/cli-home`. Vendor
 * CLIs keep logins, settings and session transcripts under HOME (and
 * CLAUDE_CONFIG_DIR / CODEX_HOME), so a personal run gets its own — another
 * user's run never reads this user's vendor state, nor the server's.
 */
export function cliHomeFor(userId: string): string {
  if (!UUID.test(userId)) throw new Error(`Invalid CLI credential owner: ${userId}`);
  const home = join(getConfig().workspace.rootPath, 'users', userId, 'cli-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/**
 * The working directory of a personal row's one-shot completion: a directory
 * of its own under the owner's CLI home, never `workspace.rootPath` (which
 * holds every user's data). The completion runs without tools, so nothing is
 * meant to be read from it; it only keeps the vendor's per-project state
 * (Claude indexes sessions by cwd) inside the owner's home.
 */
export function cliWorkDirFor(userId: string): string {
  const dir = join(cliHomeFor(userId), 'one-shot');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The credential owner of a CLI model row: `null` for an install row, the
 * row's owner and their stored token for a personal one. A personal row
 * without a token fails loud — it must never fall back to the server login —
 * and runs only for its owner: `requesterId` is the user the run serves, and
 * another user's personal row throws (`resolveModelKey`).
 */
export async function cliCredentialOwnerFor(
  row: Pick<ModelConfigEntry, 'name' | 'apiKeyRef' | 'ownerUserId' | 'provider'> | null | undefined,
  requesterId: string | null | undefined,
): Promise<CliCredentialOwner | null> {
  if (!row?.ownerUserId) return null;
  const { resolveModelKey, PersonalModelKeyMissingError } = await import('@/models/model-key');
  const token = await resolveModelKey(row, requesterId);
  if (!token) throw new PersonalModelKeyMissingError(row.name);
  return { userId: row.ownerUserId, token };
}

/**
 * The ONLY env builder for the three CLI spawn sites (agent worker, one-shot
 * provider, native compaction). An install row keeps `buildChildEnv`. A
 * personal row runs with its owner's own HOME/CLAUDE_CONFIG_DIR/CODEX_HOME,
 * every server auth variable stripped (also from `toolEnv`), and only the
 * owner's token injected. Limits: the child still runs as the server's OS
 * user, so this separates vendor state and credentials, not file permissions
 * (docs/SPACES.md, "Own models").
 */
export function cliEnvFor(
  owner: CliCredentialOwner | null,
  tool: CLIToolConfig,
  toolEnv?: Record<string, string>,
  inheritApiKeys = false,
): Record<string, string> {
  if (!owner) return buildChildEnv(tool, toolEnv, inheritApiKeys);
  const env = buildChildEnv(tool, toolEnv, false);
  for (const k of SERVER_AUTH_VARS) delete env[k];
  const home = cliHomeFor(owner.userId);
  env.HOME = home;
  env.USERPROFILE = home;
  env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  env.CODEX_HOME = join(home, '.codex');
  env.XDG_CONFIG_HOME = join(home, '.config');
  env[authVarFor(tool, owner.token)] = owner.token;
  return env;
}

/**
 * A CLI agent's environment inside a space (coworking §9.5): `HOME`,
 * `XDG_CONFIG_HOME`, `GH_CONFIG_DIR` and the version-control config move to
 * the run's own tool home (`space-tool-env.ts`: fresh, removed after the run,
 * holding only the space connector's GitHub login), and the host's agent and
 * helper variables go, so the CLI's native tools (shell, gh, version
 * control) find none of the host's — or the credential owner's, or another
 * member's — logins. The vendor's own config directory stays where `env` had
 * it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so the CLI itself is still signed in.
 */
export function cliSpaceEnv(env: Record<string, string>, home: SpaceToolHome): Record<string, string> {
  const out = { ...env };
  if (out.HOME) {
    out.CLAUDE_CONFIG_DIR ??= join(out.HOME, '.claude');
    out.CODEX_HOME ??= join(out.HOME, '.codex');
  }
  return withToolHome(out, home);
}
