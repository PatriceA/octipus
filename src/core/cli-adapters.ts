import { redactedCommand } from '@/utils/command-log';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir, } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { v7 as uuidv7 } from 'uuid';
import type { CLIAgentConfig } from '@/db/schema/models';
import { computeLineDiff } from '@/shared/diff';
import { CLI_SPACE_REFUSALS, validateCliPermissionMode, validateScopedExtraArgs } from '@/shared/cli-capabilities';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';
import { foldCacheCounters } from '@/models/providers/usage';
import { coreLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';
import { emptyCounters, type SideEffectCounters } from './swarm/receipt';
import { SHELL_GUARD_TOOL_MATCHER, getShellGuardScriptPath, shellGuardHookCommand } from './cli-shell-guard';
import { configuredCliBinary } from './cli-executable';

const IS_WIN = process.platform === 'win32';
const CLI_BRIDGE_TOOL_TIMEOUT_SECONDS = 7200;

/** How to launch the Octipus MCP server as a stdio child of a CLI tool. */
interface OctipusMcpLaunch {
  /** Runtime to exec — the running Node binary (`process.execPath`). */
  runtime: string;
  /** Absolute path to the MCP server entry point. */
  entry: string;
  /** Loopback URL the MCP server should call back into. */
  apiUrl: string;
  /** Scoped API token (may be '' before the server has booted). */
  apiKey: string;
}

/** Original image bytes read from the session workspace for this invocation. */
export interface CliImageAttachment {
  path: string;
  mimeType: string;
  data: string;
}

/** Run-scoped bridge configuration shared by CLI adapters. */
export interface CliRunConnection {
  images?: CliImageAttachment[];
  conversationId?: string;
  url: string;
  key: string;
  planMode: boolean;
  maxIterations: number;
  /** Resolve vendor configuration from the same directory used for execution. */
  workingDirectory?: string;
  /** Server-selected writable runtime directories; never agent-supplied. */
  writableRuntimePaths?: string[];
  /** Codex only: effective MCP servers from `discoverCodexMcpServers`, disabled for the run. */
  codexMcpServers?: Array<{ name: string }>;
  /** Muse only: the run's `prepareMuseHome` config home and `museWorkspaceFor` root. */
  muse?: { home: string; workspace: string };
  /** Install the network-shell guard hook (`agent.cliShellGuard`). */
  shellGuard?: boolean;
  /**
   * The run is in a shared space (§5.6): the adapter runs in its declared
   * space mode (`CLI_SPACE_MODES`), where its native tools cannot act
   * outside Octipus's decision path; an adapter without one is refused.
   */
  space?: boolean;
  /**
   * The run is on a personal CLI row (§8.4, §8.5): the user's own token
   * gives no say over the server's tools, so it runs in the same locked mode
   * as a space run (`CLI_SPACE_MODES`) — native tools behind Octipus's
   * permission path, no user/project settings files — and an adapter
   * without one is refused.
   */
  personal?: boolean;
}

/**
 * The mode each CLI adapter runs in inside a space (docs/plans/coworking-spec.md
 * §5.6), or null when it has none and is refused there:
 *
 * - Claude-binary tools (Claude Code, GLM, Kimi): `--permission-mode default`
 *   with the stdio permission tool — every native tool use that is not a read
 *   comes back through `answerCliPermissionRequest` → `routeApprovalFor`; the
 *   operator's `allowedTools` pre-approvals are dropped.
 * - Codex: the `read-only` sandbox; its writes happen only through Octipus tools.
 * - Antigravity: `--mode plan`; likewise.
 * - Mistral Vibe (default `auto-approve`): none yet.
 * - Muse Code: none. Its tools are already Octipus's only (`prepareMuseHome`),
 *   but its login and session logs live in the server account's muse
 *   directories, shared by every member (`CLI_SPACE_REFUSALS`).
 */
export const CLI_SPACE_MODES: Readonly<Record<string, string | null>> = {
  'Claude Code': 'permission mode default with the stdio permission tool',
  'Codex CLI': 'read-only sandbox',
  Antigravity: 'plan mode',
  'Mistral Vibe': null,
  'Muse Code': null,
};

/** Throws unless `adapter` declares a space mode. */
export function assertCliSpaceMode(adapter: string): string {
  const mode = CLI_SPACE_MODES[adapter];
  if (!mode) {
    throw new Error(`${adapter} cannot run in a shared space: ${CLI_SPACE_REFUSALS[adapter] ?? 'it has no mode in which its own tools stay behind Octipus\'s permission checks'}. Pick an API model or another CLI model.`);
  }
  return mode;
}

/**
 * Throws unless `adapter` can run a personal CLI row: the same locked mode
 * as a space (`CLI_SPACE_MODES`). Vibe's default is `auto-approve`, which
 * would hand any user the server's shell outside Octipus's policy.
 */
export function assertCliPersonalMode(adapter: string): string {
  const mode = CLI_SPACE_MODES[adapter];
  if (!mode) {
    throw new Error(`${adapter} cannot run on a personal model: ${CLI_SPACE_REFUSALS[adapter] ?? 'it has no mode in which its own tools stay behind Octipus\'s permission checks'}.`);
  }
  return mode;
}

/** The run is locked to its adapter's space mode: a space run, or a personal row's. */
function lockedRun(connection: CliRunConnection | undefined): boolean {
  return !!(connection?.space || connection?.personal);
}

/**
 * List Codex's effective MCP configuration for a session directory. Async so a
 * slow `codex` binary never stalls the event loop. The command only reads
 * config; it does not connect to MCP servers. Errors are sanitized: subprocess
 * output can contain credentials.
 */
export async function discoverCodexMcpServers(
  workingDirectory: string,
  /**
   * The env the run itself spawns with (`cliEnvFor`). Its HOME/CODEX_HOME
   * decide which `config.toml` codex reads: a personal row's lives in the
   * owner's CLI home, and listing the server's instead would leave every MCP
   * server the owner configured enabled.
   */
  runEnv: Record<string, string | undefined>,
): Promise<Array<{ name: string }>> {
  if (typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)) throw new Error('Scoped Codex MCP discovery requires the absolute session working directory');
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'CODEX_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR']) {
    if (runEnv[name] !== undefined) env[name] = runEnv[name];
  }
  let configured: unknown;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('codex', ['mcp', 'list', '--json'], {
        cwd: workingDirectory, env, encoding: 'utf8', timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        // Windows installs expose a .cmd launcher; all arguments here are fixed.
        shell: IS_WIN,
      }, (err, out) => err ? reject(err) : resolve(String(out)));
    });
    configured = JSON.parse(stdout);
  } catch {
    throw new Error('Cannot inspect effective Codex MCP configuration; refusing to launch an unscoped CLI run. Check codex mcp list --json in the session directory.');
  }
  if (!Array.isArray(configured) || configured.some(server => !server || typeof server !== 'object' || typeof server.name !== 'string' || !server.name)) {
    throw new Error('Invalid Codex MCP configuration listing; refusing to launch an unscoped CLI run');
  }
  return configured.map(server => ({ name: server.name as string }));
}

/** Works both from src/core and the bundled dist/index.js. Never guess a parent. */
export function resolveCliMcpEntry(moduleDir = import.meta.dirname): string {
  let dir = resolve(moduleDir);
  while (true) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'octipus') {
      const entry = join(dir, 'mcp-server/dist/index.js');
      if (!existsSync(entry)) throw new Error('CLI tool bridge is not built. Run npm run build --prefix mcp-server.');
      return entry;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot locate Octipus installation for CLI tool bridge');
    dir = parent;
  }
}

function resolveOctipusMcpLaunch(connection?: CliRunConnection): OctipusMcpLaunch {
  const entry = resolveCliMcpEntry();
  const apiPort = process.env.API_PORT || process.env.PORT || '3005';
  return { runtime: process.execPath, entry, apiUrl: connection?.url ?? `http://127.0.0.1:${apiPort}`,
    apiKey: connection?.key ?? process.env.OCTIPUS_API_KEY ?? readMcpBootstrapToken() };
}

/**
 * Read the MCP bootstrap api token the server mints at boot (mode-600 file at
 * ~/.octipus/mcp-token). Returns '' if absent/unreadable — callers then emit a
 * keyless config, same as before.
 */
function readMcpBootstrapToken(): string {
  try {
    const tokenPath = join(homedir(), '.octipus', 'mcp-token');
    if (!existsSync(tokenPath)) return '';
    const raw = readFileSync(tokenPath, 'utf-8').trim();
    return raw || '';
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to read MCP bootstrap token for CLI subagent — MCP calls may be unauthenticated');
    return '';
  }
}

/** A directory is swept at most this often: callers run on every spawn. */
const SWEEP_INTERVAL_MS = 3600_000;
const lastSweepAt = new Map<string, number>();

/**
 * Delete files matching `prefix` in `dir` that are older than `maxAgeMs`.
 * Best-effort retention sweep for ephemeral config/prompt dumps. Runs at
 * most once per `SWEEP_INTERVAL_MS` per dir and prefix — it stats every
 * file, and the files it is after are days old.
 */
export function sweepStaleFiles(dir: string, prefix: string, maxAgeMs: number): void {
  const key = `${dir}\0${prefix}`;
  const now = Date.now();
  if (now - (lastSweepAt.get(key) ?? -Infinity) < SWEEP_INTERVAL_MS) return;
  lastSweepAt.set(key, now);
  try {
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
      } catch { /* raced with another sweep */ }
    }
  } catch (err) {
    coreLogger.debug({ err, dir }, 'Stale-file sweep failed');
  }
}

/**
 * Generate a per-agent MCP config file that points CLI tools to Octipus's MCP
 * server. Always regenerated (the token/port can rotate between spawns — the
 * old 1h-staleness reuse served stale credentials), written 0600 because it
 * carries the scoped API token. Stale per-agent files are swept after 7 days.
 */
function getOrCreateMcpConfig(agentId?: string, connection?: CliRunConnection): string | null {
  const dir = join(tmpdir(), 'octipus-cli');
  const suffix = agentId || randomBytes(6).toString('hex');
  const configPath = join(dir, `mcp-config-${suffix}.json`);

  const launch = resolveOctipusMcpLaunch(connection);

  const config = {
    mcpServers: {
      octipus: {
        command: launch.runtime,
        args: [launch.entry],
        env: {
          ...(connection ? { OCTIPUS_AGENT_URL: launch.apiUrl, OCTIPUS_AGENT_KEY: launch.apiKey } : {
            OCTIPUS_URL: launch.apiUrl, ...(launch.apiKey ? { OCTIPUS_API_KEY: launch.apiKey } : {}),
          }),
        },
      },
    },
  };

  mkdirSync(dir, { recursive: true });
  sweepStaleFiles(dir, 'mcp-config-', 7 * 24 * 3600_000);
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

/** Cached path — content is fixed (`{"mcpServers":{}}`), so write it once and reuse. */
let emptyMcpConfigPath: string | null = null;

/**
 * Absolute path to a constant `{"mcpServers":{}}` file, paired with
 * `--strict-mcp-config` to isolate a Claude-binary CLI run that has no
 * Octipus MCP server to inject: a one-shot text completion
 * (`src/models/providers/cli-provider.ts`, never needs tools) or an agent
 * run whose tool bridge failed to start (`connection` undefined, so there is
 * no scoped `octipus` server to register). Lazily created once per process —
 * unlike the per-agent config (which carries a rotating token), this file's
 * content never changes.
 */
export function getEmptyMcpConfigPath(): string {
  if (emptyMcpConfigPath && existsSync(emptyMcpConfigPath)) return emptyMcpConfigPath;
  const dir = join(tmpdir(), 'octipus-cli');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'mcp-config-empty.json');
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  emptyMcpConfigPath = configPath;
  return configPath;
}

/** Claude `--settings` file registering the shell guard as a PreToolUse hook. */
export function getClaudeShellGuardSettingsPath(): string {
  const path = join(dirname(getShellGuardScriptPath()), 'claude-shell-guard.json');
  writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: SHELL_GUARD_TOOL_MATCHER, hooks: [{ type: 'command', command: shellGuardHookCommand() }] }] } }));
  return path;
}

/**
 * The whole Claude settings of a space run (§5.6), passed with
 * `--setting-sources=` so no user, project or local settings file is read:
 * a member's agent could otherwise write `<space>/.claude/settings.json`
 * (pre-approved tools, hooks) and act in every other member's runs, and the
 * host's own allow rules would skip the stdio permission tool. No
 * pre-approved tool, bypass mode disabled, no project MCP servers; the shell
 * guard hook is the only hook, when it is on. Managed (policy) settings
 * still apply — they are the operator's.
 */
export function getClaudeSpaceSettingsPath(shellGuard: boolean): string {
  const dir = shellGuard ? dirname(getShellGuardScriptPath()) : join(tmpdir(), 'octipus-cli');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, shellGuard ? 'claude-space-guarded.json' : 'claude-space.json');
  writeFileSync(path, JSON.stringify({
    permissions: { allow: [], defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
    enableAllProjectMcpServers: false,
    hooks: shellGuard ? { PreToolUse: [{ matcher: SHELL_GUARD_TOOL_MATCHER, hooks: [{ type: 'command', command: shellGuardHookCommand() }] }] } : {},
  }), { mode: 0o600 });
  return path;
}

/** Windows-only `.cmd` wrapper Codex's hook calls by bare path (see the Codex builder for why). */
export function getCodexShellGuardWrapper(): string {
  // ponytail: a temp dir path with a space would need quotes again; add a no-space fallback dir if that ever occurs.
  const path = join(dirname(getShellGuardScriptPath()), 'shell-guard.cmd');
  writeFileSync(path, `@${shellGuardHookCommand()}\r\n`);
  return path;
}

/** Antigravity customization root holding `.agents/hooks.json` for the shell guard. */
export function getAgyShellGuardDir(): string {
  const dir = join(dirname(getShellGuardScriptPath()), 'agy-shell-guard');
  mkdirSync(join(dir, '.agents'), { recursive: true });
  // agy runs Windows hooks via Go's `cmd /c`, which backslash-escapes every
  // quote (verified live: cmd then can't find `\"C:\Program Files\...`). A
  // quote-free relative wrapper sidesteps it; hooks run in the hooks.json dir.
  // Explicit `.\`: NoDefaultCurrentDirectoryInExePath may be inherited.
  if (IS_WIN) writeFileSync(join(dir, '.agents', 'shell-guard.cmd'), `@${shellGuardHookCommand()}\r\n`);
  const command = IS_WIN ? '.\\shell-guard.cmd' : shellGuardHookCommand();
  writeFileSync(join(dir, '.agents', 'hooks.json'), JSON.stringify({ 'octipus-shell-guard': { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command }] }] } }));
  return dir;
}

/** Cached path — reseeded only if the dir has gone missing. */
let emptyVibeHomeDir: string | null = null;

/**
 * Ephemeral `VIBE_HOME` with `mcp_servers = []`, for a one-shot vibe
 * completion (`cli-provider.ts`): no bridge, no tools needed, so vibe should
 * see none of the host's configured MCP servers either. vibe has no
 * `--mcp-config` flag, so an isolated `VIBE_HOME` is the only lever. Cached
 * for the process lifetime (mirrors {@link getEmptyMcpConfigPath}): the
 * seeded auth/trust files don't change turn to turn. Returns null when vibe
 * was never set up (no `config.toml`) — the caller then spawns vibe with its
 * own defaults.
 */
export function getEmptyVibeHome(): string | null {
  if (emptyVibeHomeDir && existsSync(join(emptyVibeHomeDir, 'config.toml'))) return emptyVibeHomeDir;
  const realHome = process.env.VIBE_HOME || join(homedir(), '.vibe');
  const realConfig = join(realHome, 'config.toml');
  if (!existsSync(realConfig)) return null;
  const dir = join(tmpdir(), 'octipus-cli', 'vibe-home-empty');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const realEnv = join(realHome, '.env');
    if (existsSync(realEnv)) copyFileSync(realEnv, join(dir, '.env'));
    const realTrust = join(realHome, 'trusted_folders.toml');
    if (existsSync(realTrust)) copyFileSync(realTrust, join(dir, 'trusted_folders.toml'));
    const parsed = parseToml(readFileSync(realConfig, 'utf-8'));
    parsed.mcp_servers = [];
    writeFileSync(join(dir, 'config.toml'), stringifyToml(parsed), { mode: 0o600 });
    emptyVibeHomeDir = dir;
    return dir;
  } catch (err) {
    coreLogger.warn({ err }, 'Failed to seed empty VIBE_HOME for one-shot isolation — vibe will run with host MCP config');
    return null;
  }
}

/**
 * Inject (or replace) a top-level `mcp_servers` assignment in a vibe
 * `config.toml` with one that registers the Octipus MCP server. vibe's schema
 * makes `mcp_servers` a list, and the default config writes it as an inline
 * empty array (`mcp_servers = []`) — so we replace that single-line assignment
 * with an inline array-of-tables. (A `[[mcp_servers]]` table block would
 * collide with the existing `mcp_servers = []` and be a TOML redefinition.)
 */
export function injectVibeMcpServer(config: string, launch: OctipusMcpLaunch, scoped = false): string {
  const parsed = parseToml(config);
  const existing = parsed.mcp_servers ?? [];
  if (!Array.isArray(existing)) throw new Error('Vibe mcp_servers must be an array');
  const urlName = scoped ? 'OCTIPUS_AGENT_URL' : 'OCTIPUS_URL';
  const keyName = scoped ? 'OCTIPUS_AGENT_KEY' : 'OCTIPUS_API_KEY';
  parsed.mcp_servers = [
    ...(scoped ? [] : existing).filter(item => typeof item !== 'object' || item === null || !('name' in item) || !['octipus', 'assistant'].includes(String(item.name))),
    { name: 'octipus', transport: 'stdio', command: launch.runtime, args: [launch.entry],
      ...(scoped ? { tool_timeout_sec: CLI_BRIDGE_TOOL_TIMEOUT_SECONDS } : {}),
      env: { [urlName]: launch.apiUrl, ...(launch.apiKey ? { [keyName]: launch.apiKey } : {}) } },
  ];
  return stringifyToml(parsed);
}

/**
 * Build an ephemeral `VIBE_HOME` seeded from the host's real `~/.vibe`, with the
 * Octipus MCP server merged into `config.toml`. vibe honors `VIBE_HOME` to
 * relocate its config dir; spawning with `env.VIBE_HOME` set lets us register
 * the MCP server without mutating the user's real config (vibe has no
 * `--mcp-config` flag). Returns the dir, or null if vibe isn't set up (no
 * config.toml) — in which case the caller spawns vibe with its own defaults.
 *
 * The dir is UNIQUE per spawn: Octipus is always multi-user and CLI agents run
 * concurrently, and vibe writes per-run session state (history, logs, cache)
 * into VIBE_HOME — a shared dir would let concurrent agents corrupt each other's
 * config.toml mid-write and cross-contaminate session state. The caller is
 * responsible for removing the returned dir when the vibe process exits.
 */
function getOrCreateVibeHome(connection?: CliRunConnection): string | null {
  const realHome = process.env.VIBE_HOME || join(homedir(), '.vibe');
  const realConfig = join(realHome, 'config.toml');
  // Nothing to seed if vibe was never set up — let vibe fall back to defaults
  // (it will still run, just without the Octipus MCP server).
  if (!existsSync(realConfig) && !connection) return null;

  const dir = join(tmpdir(), 'octipus-cli', `vibe-home-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Seed creds + trust list into the fresh dir so vibe finds the API key.
    const realEnv = join(realHome, '.env');
    if (existsSync(realEnv)) copyFileSync(realEnv, join(dir, '.env'));
    const realTrust = join(realHome, 'trusted_folders.toml');
    if (existsSync(realTrust)) copyFileSync(realTrust, join(dir, 'trusted_folders.toml'));

    // Write config.toml with a fresh MCP launch (entry/port/token) merged in.
    const launch = resolveOctipusMcpLaunch(connection);
    const merged = injectVibeMcpServer(existsSync(realConfig) ? readFileSync(realConfig, 'utf-8') : '', launch, !!connection);
    writeFileSync(join(dir, 'config.toml'), merged, { mode: 0o600 });
    return dir;
  } catch (err) {
    if (connection) throw err;
    coreLogger.warn({ err }, 'Failed to seed VIBE_HOME for Octipus MCP — vibe will run without it');
    return null;
  }
}

/**
 * Unwrap a shell-wrapper invocation (`zsh -lc '…'`, `bash -c "…"`, `/bin/sh -c …`)
 * and return the inner command. Codex wraps every step this way, which used to
 * title every tool row "zsh". Non-wrapped commands are returned trimmed.
 */
export function unwrapShellCommand(command: string): string {
  const m = command.trim().match(/^\S*\b(?:zsh|bash|sh)\s+-(?:l?i?c)\s+([\s\S]+)$/);
  if (!m) return command.trim();
  let inner = m[1].trim();
  if (
    (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2) ||
    (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2)
  ) {
    inner = inner.slice(1, -1);
  }
  return inner.trim();
}

/**
 * Find a real stdout file redirect in a command. Ignores stderr redirects
 * (`2>/dev/null`), fd dups (`>&2`), `/dev/null` targets, and `->` arrows
 * inside words — all of which used to false-positive as "write_file".
 */
function findStdoutRedirect(command: string): { append: boolean; path: string } | null {
  const re = /(^|\s)(\d*)(>>|>)\s*("[^"]+"|'[^']+'|[^\s&|;]+)/g;
  for (const m of command.matchAll(re)) {
    const fd = m[2];
    const target = m[4];
    if (fd && fd !== '1') continue;          // stderr / other-fd redirect
    if (target.startsWith('&')) continue;    // fd dup like >&2
    const path = stripQuotes(target);
    if (path === '/dev/null') continue;
    return { append: m[3] === '>>', path };
  }
  return null;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2) ||
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

const COMMAND_TITLE_MAX = 60;

/** Human title for a shell command row: first token + capped args of the unwrapped command. */
export function titleFromCommand(command: string): string {
  const inner = unwrapShellCommand(command).replace(/\s+/g, ' ').trim();
  if (!inner) return 'shell';
  return inner.length > COMMAND_TITLE_MAX ? `${inner.slice(0, COMMAND_TITLE_MAX - 1)}…` : inner;
}

/** Detect a more descriptive tool name from a shell command */
export function detectToolFromCommand(command: string): string {
  const inner = unwrapShellCommand(command);
  const cmd = inner.split(/\s+/)[0]?.replace(/^.*[\\/]/, '') || 'shell';
  const toolMap: Record<string, string> = {
    cat: 'read_file', find: 'find', ls: 'list', grep: 'search', rg: 'search',
    sed: 'edit_file', mkdir: 'create_dir', rm: 'delete', cp: 'copy', mv: 'move',
    flutter: 'flutter', npm: 'npm', bun: 'bun', git: 'git', docker: 'docker',
    cd: 'shell', echo: 'shell', python: 'python', python3: 'python', node: 'node',
  };
  const redirect = findStdoutRedirect(inner);
  if (redirect) return redirect.append ? 'append_file' : 'write_file';
  return toolMap[cmd] || cmd;
}

/** Detect file changes from shell commands like `cat > file`, `sed -i`, `mkdir -p` */
export function detectFileChangeFromCommand(command: string): { action: string; path: string } | null {
  const inner = unwrapShellCommand(command);
  const QUOTED_OR_BARE = `("[^"]+"|'[^']+'|\\S+)`;
  // Any stdout redirect to a file (cat > file, echo … >> file, …)
  const redirect = findStdoutRedirect(inner);
  if (redirect) return { action: redirect.append ? 'append' : 'write', path: redirect.path };
  // sed -i (in-place edit) — last non-flag argument is the file
  const sedEdit = inner.match(new RegExp(`\\bsed\\s+-i\\S*\\s+.*?${QUOTED_OR_BARE}\\s*$`));
  if (sedEdit) return { action: 'edit', path: stripQuotes(sedEdit[1]) };
  // mkdir -p
  const mkdirCreate = inner.match(new RegExp(`\\bmkdir\\s+(?:-\\S+\\s+)*${QUOTED_OR_BARE}`));
  if (mkdirCreate && !mkdirCreate[1].startsWith('-')) return { action: 'create_dir', path: stripQuotes(mkdirCreate[1]) };
  // rm / rm -rf — skip any number of flags, take the first real path
  const rmDelete = inner.match(new RegExp(`\\brm\\s+(?:-\\S+\\s+)*${QUOTED_OR_BARE}`));
  if (rmDelete && !rmDelete[1].startsWith('-')) return { action: 'delete', path: stripQuotes(rmDelete[1]) };
  return null;
}

/**
 * Shared permission levels across CLI adapters (C14). Each adapter translates
 * to its native flag; native values of the SAME adapter pass through, but a
 * foreign adapter's native value is rejected loudly instead of producing an
 * exit-1 invalid-arg spawn.
 */
export type CLIPermissionLevel = 'safe' | 'workspace' | 'full';

const CLAUDE_PERM_MAP: Record<CLIPermissionLevel, string> = {
  safe: 'default',
  workspace: 'acceptEdits',
  full: 'bypassPermissions',
};
const CLAUDE_NATIVE_PERMS = new Set(['default', 'manual', 'dontAsk', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']);

const CODEX_PERM_MAP: Record<CLIPermissionLevel, string> = {
  safe: 'read-only',
  workspace: 'workspace-write',
  full: 'danger-full-access',
};
const CODEX_NATIVE_PERMS = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function resolveClaudePermissionMode(mode: string | undefined): string {
  // Default is `workspace` (acceptEdits): edits inside the workspace flow, and
  // everything else raises a native permission request that the stdio relay
  // routes through Octipus' ALLOW/ASK/DENY. `bypassPermissions` (the old
  // default) never emits those requests, which made the relay inert.
  if (!mode) return CLAUDE_PERM_MAP.workspace;
  if (mode in CLAUDE_PERM_MAP) return CLAUDE_PERM_MAP[mode as CLIPermissionLevel];
  if (CLAUDE_NATIVE_PERMS.has(mode)) return mode;
  throw new Error(
    `Invalid permissionMode "${mode}" for Claude Code — use 'safe'|'workspace'|'full' or a native Claude mode (${[...CLAUDE_NATIVE_PERMS].join(', ')})`,
  );
}

export function resolveCodexSandboxMode(mode: string | undefined): string {
  if (!mode) return CODEX_PERM_MAP.workspace; // historical default for spawned agents
  if (mode === 'auto') return CODEX_PERM_MAP.workspace;
  if (mode in CODEX_PERM_MAP) return CODEX_PERM_MAP[mode as CLIPermissionLevel];
  if (CODEX_NATIVE_PERMS.has(mode)) return mode;
  throw new Error(
    `Invalid permissionMode "${mode}" for Codex CLI — use 'safe'|'workspace'|'full' or a native codex sandbox (${[...CODEX_NATIVE_PERMS].join(', ')})`,
  );
}

export function resolveVibeMode(mode?: string): string {
  if (!mode || mode === 'full' || mode === 'yolo') return 'auto-approve';
  if (['auto-approve', 'accept-edits', 'default'].includes(mode)) return mode;
  if (mode === 'safe' || mode === 'plan') return 'plan';
  if (mode === 'workspace' || mode === 'auto_edit' || mode === 'auto') return 'accept-edits';
  throw new Error(`Unsupported Mistral Vibe permission mode: ${mode}`);
}

/** Octipus's MCP server in a muse run. The run's settings hold no other server, so no per-run namespace is needed. */
const MUSE_BRIDGE_SERVER = 'octipus';

/** The name muse gives a bridge tool (`mcp__<server>__<tool>`), which `run.toolset` lists. */
export function museBridgeToolName(name: string): string {
  return `mcp__${MUSE_BRIDGE_SERVER}__${name}`;
}

/** JSON-RPC ids of a muse run's own requests (`buildMuseArgs`). */
const MUSE_OPEN_ID = 2;
const MUSE_TURN_ID = 3;

/** One MSP (JSON-RPC 2.0) line; a notification without `id`. */
export function mspLine(id: number | undefined, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n';
}

/**
 * What the worker does with a `muse serve` run's stdin after `message`:
 * write the turn once the session is open, end input (serve then exits)
 * once the turn is over, a request failed, or muse asked something an
 * Octipus run never answers (the parser reports the last two as failures).
 */
export function museProtocolStep(message: Record<string, unknown>, turn: string): { write?: string; end?: boolean } {
  if (message.id === MUSE_OPEN_ID && message.result) return { write: turn };
  if (message.error || message.method === 'turn/completed' || (message.method && message.id !== undefined)) return { end: true };
  return {};
}

/**
 * muse's workspace root for runs on `workingDirectory`: an empty directory,
 * trusted only in the run's own settings. muse loads MCP servers only in a
 * trusted workspace, and a trusted workspace also loads its rules
 * (`AGENTS.md`), skills and `.mcp.json` servers — verified on 1.4.18, a
 * workspace `.mcp.json` server is spawned — so the trusted root holds
 * nothing. Octipus's tools act in the real workspace, and Octipus injects its
 * AGENTS.md itself. Stable per workspace: a resumed session keeps its root.
 */
export function museWorkspaceFor(workingDirectory: string): string {
  const dir = join(tmpdir(), 'octipus-cli', 'muse-ws', createHash('sha256').update(workingDirectory).digest('hex').slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The muse config directory a child with `env` reads (`$XDG_CONFIG_HOME/muse`). */
function museConfigDir(env: Record<string, string | undefined>): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'muse');
}

/**
 * A per-run `XDG_CONFIG_HOME` for muse whose only tools are the run's Octipus
 * bridge. muse reads its whole user configuration from there, so the user's
 * own MCP servers, rules and settings stay out; `-c` could not do this (it may
 * add an MCP server but never disable a configured one). The settings file:
 *
 * - `run.toolset`: exactly the bridge's tools. Without a listed name a tool is
 *   not offered, so every native tool (shell, file writes, web, memory,
 *   request_user_input, subagents, workflows, cron) is gone; an empty list
 *   leaves none at all (verified live). A listed name muse does not see fails
 *   the run ("unknown tool names") — fail loud if the bridge did not load.
 * - native subagents and cross-session messaging off; no foreign personal
 *   rules or skills (`~/.claude`, `~/.codex`, `~/.agents`); every other skill
 *   (bundled, user, plugin) switched off by path, as `muse skills disable`
 *   writes it, so no skill catalog reaches the prompt either.
 * - the user's default `model` / `provider` / reasoning efforts (not secret).
 *
 * The login is linked, never copied or read: `auth.json` points at the
 * user's own. `trust.json` trusts only the empty `workspace`. With no `tools`
 * (a tool-less one-shot completion) there is no bridge server and nothing is
 * trusted. Remove with {@link disposeMuseHome}.
 */
export async function prepareMuseHome(opts: { workspace: string; tools: readonly string[]; env: Record<string, string | undefined> }): Promise<string> {
  const real = museConfigDir(opts.env);
  mkdirSync(join(tmpdir(), 'octipus-cli'), { recursive: true });
  sweepStaleMuseHomes(opts.env);
  const home = mkdtempSync(join(tmpdir(), 'octipus-cli', 'muse-home-'));
  const dir = join(home, 'muse');
  try {
    writeFileSync(join(home, MUSE_AUTH_BASE), museAuthStamp(join(real, 'auth.json')), { mode: 0o600 });
    mkdirSync(dir, { mode: 0o700 });
    if (existsSync(join(real, 'auth.json'))) symlinkSync(join(real, 'auth.json'), join(dir, 'auth.json'));
    const userPath = join(real, 'settings.json');
    const user = existsSync(userPath) ? JSON.parse(readFileSync(userPath, 'utf8')) as Record<string, unknown> : {};
    const settings: Record<string, unknown> = {
      schema_version: 1,
      ...Object.fromEntries(['provider', 'model', 'model_reasoning_efforts'].filter(key => user[key] !== undefined).map(key => [key, user[key]])),
      run: { toolset: opts.tools.map(museBridgeToolName), subagent_delegation_mode: 'off' },
      context: { foreign_personal_rules: false, foreign_personal_skills: false },
      local_session_messaging: { enabled: false },
    };
    if (opts.tools.length) {
      // Secret leaves stay whole-value `${VAR}` references: the worker sets both.
      settings.mcpServers = { [MUSE_BRIDGE_SERVER]: { command: process.execPath, args: [resolveCliMcpEntry()], required: true,
        env: { OCTIPUS_AGENT_URL: '${OCTIPUS_AGENT_URL}', OCTIPUS_AGENT_KEY: '${OCTIPUS_AGENT_KEY}' }, tool_timeout_sec: CLI_BRIDGE_TOOL_TIMEOUT_SECONDS } };
      writeFileSync(join(dir, 'trust.json'), JSON.stringify({ schema_version: 1, projects: { [opts.workspace]: { decision: 'trusted' } } }), { mode: 0o600 });
    }
    const write = () => writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
    write();
    const listing = await new Promise<string>((resolve, reject) => {
      execFile(configuredCliBinary('muse'), ['skills', 'list', '--json', '--workspace', opts.workspace], {
        cwd: opts.workspace, env: { ...opts.env, XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      }, (err, out) => err ? reject(new Error(`Cannot list Muse Code skills (muse skills list --json): ${err.message}`)) : resolve(String(out)));
    });
    const skills = (JSON.parse(listing) as { skills?: Array<{ scope?: unknown; path?: unknown; activation?: unknown }> }).skills;
    if (!Array.isArray(skills)) throw new Error('Invalid Muse Code skills listing');
    const activation: Record<string, Record<string, string>> = {};
    for (const skill of skills) {
      if (typeof skill.scope !== 'string' || typeof skill.path !== 'string' || skill.activation === 'off') continue;
      (activation[skill.scope] ??= {})[skill.path] = 'off';
    }
    if (Object.keys(activation).length) {
      settings.skills = { activation };
      write();
    }
    return home;
  } catch (err) {
    disposeMuseHome(home);
    throw err;
  }
}

/**
 * Remove a {@link prepareMuseHome} directory. Should muse ever replace the
 * linked `auth.json` with a file of its own (a token refresh written by
 * rename), that file is the current login: it is moved back over the user's,
 * never deleted, read or left behind.
 */
export function disposeMuseHome(home: string, env: Record<string, string | undefined> = process.env): void {
  const auth = join(home, 'muse', 'auth.json');
  try {
    if (existsSync(auth) && !lstatSync(auth).isSymbolicLink()) {
      const realAuth = join(museConfigDir(env), 'auth.json');
      if (!(statSync(auth).size > 0)) {
        coreLogger.warn({ home }, 'Muse Code left an empty login file; the user login is kept');
      } else if (museAuthStamp(realAuth) !== readFileSync(join(home, MUSE_AUTH_BASE), 'utf8')) {
        // Another run or the user's own muse wrote the login since this run
        // started: theirs is at least as new. Keep it, drop this copy.
        coreLogger.warn({ home }, 'Muse Code login changed elsewhere during a run; kept the newer one');
      } else {
        // Copy next to the target, then rename: /tmp and $HOME are often
        // different filesystems (EXDEV), and the rename keeps it atomic.
        mkdirSync(dirname(realAuth), { recursive: true, mode: 0o700 });
        const staged = `${realAuth}.octipus-${process.pid}-${randomUUID()}`;
        copyFileSync(auth, staged);
        chmodSync(staged, 0o600);
        renameSync(staged, realAuth);
        coreLogger.warn({ home }, 'Muse Code rewrote its login during a run; moved it back to the user configuration');
      }
    }
  } catch (err) {
    // Keep the directory: it may hold the only copy of a refreshed login.
    coreLogger.error({ err, home }, 'Muse Code login written during a run could not be moved back; its run directory is kept');
    return;
  }
  rmSync(home, { recursive: true, force: true });
}

/** The user's login as `prepareMuseHome` saw it (mtime and size, never its contents). */
const MUSE_AUTH_BASE = 'auth-base';
function museAuthStamp(path: string): string {
  if (!existsSync(path)) return 'none';
  const s = statSync(path);
  return `${s.mtimeMs} ${s.size}`;
}

/** Dispose `muse-home-*` dirs older than a day (a crashed server), login move-back included. */
function sweepStaleMuseHomes(env: Record<string, string | undefined>): void {
  const root = join(tmpdir(), 'octipus-cli');
  const cutoff = Date.now() - 24 * 3600_000;
  try {
    for (const name of readdirSync(root)) {
      const home = join(root, name);
      if (name.startsWith('muse-home-') && statSync(home).mtimeMs < cutoff) disposeMuseHome(home, env);
    }
  } catch (err) {
    coreLogger.debug({ err }, 'Muse Code home sweep failed');
  }
}

/**
 * Whether muse holds a session log for `id`. muse continues a session given
 * the same `--session-id`, but under an id it does not know it silently
 * starts a new one — so a resume is checked first. Layout (muse's own
 * session-identity note): `${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`.
 */
export function museSessionLogExists(id: string, env: Record<string, string | undefined>): boolean {
  const root = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'muse', 'sessions');
  // Only the numeric date levels: the sessions root also holds lock files and view caches.
  const list = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(name => /^\d+$/.test(name)) : [];
  for (const year of list(root)) for (const month of list(join(root, year))) for (const day of list(join(root, year, month))) {
    if (existsSync(join(root, year, month, day, id, 'session.jsonl'))) return true;
  }
  return false;
}

/**
 * Builds CLI arguments for different agent tools (Claude Code, Antigravity, Codex, Mistral Vibe).
 *
 * On Windows, prompts are piped via stdin (not as args) because shell: true
 * is required for .cmd wrappers but mangles long/special-char arguments.
 * When stdinPrompt is returned, the caller must write it to proc.stdin.
 */
export const CLAUDE_NATIVE_SUBAGENT_TOOLS = ['Task', 'Agent'];
export const CODEX_NATIVE_SUBAGENT_FEATURES = ['multi_agent', 'multi_agent_v2'];

/** Pull `--disallowedTools`/`--disallowed-tools` (space, comma or `=` form) out of extraArgs so they can be merged into one flag. */
export function splitClaudeDisallowedTools(extraArgs: readonly string[]): { disallowed: string[]; rest: string[] } {
  const disallowed: string[] = [];
  const rest: string[] = [];
  const add = (v: string) => disallowed.push(...v.split(',').map(t => t.trim()).filter(Boolean));
  for (let i = 0; i < extraArgs.length; i++) {
    const [flag, inline] = extraArgs[i].split(/=(.*)/s);
    if (flag !== '--disallowedTools' && flag !== '--disallowed-tools') { rest.push(extraArgs[i]); continue; }
    if (inline !== undefined) { add(inline); continue; }
    while (i + 1 < extraArgs.length && !extraArgs[i + 1].startsWith('-')) add(extraArgs[++i]);
  }
  return { disallowed, rest };
}

export class CLIArgumentBuilder {
  build(
    toolName: string,
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
    systemPrompt?: string | null,
    maxTokenBudget?: number,
    agentId?: string,
    connection?: CliRunConnection,
    resume?: { id: string; isFirstRun: boolean },
  ): { binary: string; args: string[]; stdinPrompt?: string; keepStdinOpen?: boolean; museTurn?: string; useShell?: boolean; env?: Record<string, string> } {
    if (connection?.images?.length && toolName !== 'Claude Code' && toolName !== 'Codex CLI' && toolName !== 'Muse Code') {
      prompt += '\n\nOriginal image attachments (inspect with your native image-reading tool):\n' + connection.images.map(image => JSON.stringify(image.path)).join('\n');
    }
    if (connection) validateScopedExtraArgs(toolName, settings.extraArgs ?? []);
    if (connection?.space) assertCliSpaceMode(toolName);
    if (connection?.personal) assertCliPersonalMode(toolName);
    // `toolName` is the CLIToolConfig.adapter key (defaults to name). Vendors
    // that reuse the Claude binary (z.ai GLM, Moonshot Kimi) pass 'Claude Code'.
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings, systemMessages, agentId, connection, resume);
      case 'Antigravity':
        return this.buildAntigravityArgs(prompt, settings, systemPrompt, connection);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt, systemPrompt, settings, connection, resume);
      case 'Mistral Vibe':
        return this.buildVibeArgs(prompt, settings, maxTokenBudget, connection);
      case 'Muse Code':
        return this.buildMuseArgs(prompt, settings, systemPrompt, connection, resume);
      default:
        throw new Error(`Unknown CLI tool: ${toolName}`);
    }
  }

  private buildVibeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    maxTokenBudget?: number,
    connection?: CliRunConnection,
  ): { binary: string; args: string[]; stdinPrompt?: string; env?: Record<string, string> } {
    // vibe -p runs programmatic mode (send prompt → emit JSON message array →
    // exit). --trust skips the workdir trust prompt; --auto-approve allows tool
    // calls without blocking on approval. --output json is parsed at process
    // close (CLIToolConfig.bufferOutput) — `streaming` hangs in a non-interactive
    // pipe. Model is chosen by vibe's own config (active_model), not a flag.
    const args = ['-p'];

    // On Windows, shell:true re-tokenizes argv and mangles long/special-char
    // prompts; pipe via stdin instead (vibe reads the prompt from stdin when -p
    // is given no inline text). Linux/macOS spawn argv is safe — pass inline.
    if (!IS_WIN) {
      args.push(prompt);
    }

    args.push('--output', 'json', '--trust');
    args.push('--agent', connection?.planMode ? 'plan' : resolveVibeMode(settings.permissionMode));
    if (Number.isFinite(connection?.maxIterations)) args.push('--max-turns', String(connection!.maxIterations));

    // vibe reports no token/cost usage in its output, so the worker's
    // token-budget kill can't fire — let vibe self-limit via its caps instead.
    if (settings.maxBudgetUsd != null) {
      args.push('--max-price', String(settings.maxBudgetUsd));
    }
    if (maxTokenBudget && maxTokenBudget > 0) {
      args.push('--max-tokens', String(maxTokenBudget));
    }

    // allowedTools → vibe --enabled-tools (in -p mode this disables all others).
    if (settings.allowedTools?.length) {
      if (connection) args.push('--enabled-tools', 'octipus_*');
      for (const tool of settings.allowedTools) {
        args.push('--enabled-tools', tool);
      }
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // Point vibe at an ephemeral VIBE_HOME that registers the Octipus MCP server
    // (vibe has no --mcp-config flag). Null when vibe isn't set up — then it runs
    // with its own defaults and no Octipus MCP.
    const vibeHome = getOrCreateVibeHome(connection);
    const env = vibeHome ? { VIBE_HOME: vibeHome } : undefined;

    return {
      binary: 'vibe',
      args,
      stdinPrompt: IS_WIN ? prompt : undefined,
      env,
    };
  }

  private buildMuseArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemPrompt?: string | null,
    connection?: CliRunConnection,
    resume?: { id: string; isFirstRun: boolean },
  ): { binary: string; args: string[]; env: Record<string, string>; stdinPrompt: string; museTurn: string } {
    // A muse run's only tools are its Octipus bridge (`prepareMuseHome`); without one it has nothing to work with.
    if (!connection?.muse) throw new Error('Muse Code runs only with the Octipus tool bridge, which did not start');
    validateCliPermissionMode('Muse Code', settings.permissionMode);
    // `muse serve`: the Muse Session Protocol (MSP, JSON-RPC) over stdio, which
    // reports token usage per model call (`muse exec` only once, at the end) and
    // compacts on request (`compactMuseSession`). No request_user_input and no
    // reminder agents (background model calls); `allowAll` below: no muse
    // approval prompts or approval judge, Octipus authorizes every bridge call.
    // A run that is never resumed writes no session log (as codex --ephemeral).
    const args = ['serve', '--disable-request-user-input', '-c', 'run.reminder_roster=[]', ...(resume ? [] : ['--no-session-log'])];
    // Model override: env var > settings > the user's muse default (carried into the run's settings).
    const model = process.env.MUSE_MODEL || settings.model;
    // `--reasoning-effort` is the one scoped extra arg; MSP takes it per turn.
    const effortAt = settings.extraArgs?.indexOf('--reasoning-effort') ?? -1;
    const effort = effortAt >= 0 ? settings.extraArgs![effortAt + 1] : undefined;
    // Caller-minted session (CLI_RESUME), a UUIDv7 as MSP requires: the first
    // run starts it under that id, later runs resume it (an unknown id fails
    // with `sessionNotFound`, never silently starts over).
    const sessionId = resume?.id || uuidv7();
    const open = resume && !resume.isFirstRun
      ? mspLine(MUSE_OPEN_ID, 'session/resume', { commandId: uuidv7(), sessionId, excludeItems: true, ...(model ? { modelId: model } : {}) })
      : mspLine(MUSE_OPEN_ID, 'session/start', { commandId: uuidv7(), sessionId, workspaceRoots: [connection.muse.workspace], approvalMode: 'allowAll', ...(model ? { modelId: model } : {}) });
    // The prompt travels on stdin inside the turn: never argv, no temp file.
    const placement = connection.workingDirectory
      ? `Muse Code's own workspace root is an empty placeholder. This run's files are in ${connection.workingDirectory}; reach them only through the Octipus tools.`
      : '';
    const text = [systemPrompt, placement, prompt].filter(Boolean).join('\n\n---\n\n');
    const input = [{ type: 'text', text }, ...(connection.images ?? []).map(image => ({ type: 'image', base64Data: image.data, mediaType: image.mimeType }))];
    return {
      binary: 'muse', args, env: { XDG_CONFIG_HOME: connection.muse.home },
      stdinPrompt: mspLine(1, 'initialize', { clientInfo: { name: 'octipus', version: '1' } }) + mspLine(undefined, 'initialized') + open,
      // Sent once the session is open (`museProtocolStep`): MSP serves requests concurrently.
      museTurn: mspLine(MUSE_TURN_ID, 'turn/start', { commandId: uuidv7(), sessionId, input, ...(effort ? { reasoningEffort: effort } : {}) }),
    };
  }

  private buildClaudeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
    agentId?: string,
    connection?: CliRunConnection,
    resume?: { id: string; isFirstRun: boolean },
  ): { binary: string; args: string[]; stdinPrompt?: string; keepStdinOpen?: boolean; env?: Record<string, string> } {
    // Claude Code: -p is a boolean flag (print mode), prompt is positional
    // On Windows: pipe prompt via stdin to avoid shell mangling
    const args: string[] = [];

    // A resumed run drops --append-system-prompt (Claude replays its own
    // snapshot of the first turn's system prompt), but `systemMessages` is NOT
    // static: its tail is root-runner's VOLATILE tier — the wall-clock date
    // stamp, this turn's memory and attached-file blocks, the tool-budget
    // notice and `buildSecurityReminder(guardFlags)`.
    // Relying on the snapshot froze the date at turn 1 and threw away a
    // security reminder raised by content that arrived on turn 7. Ride the
    // volatile tier in on the delta user message instead, which is the only
    // channel a resumed turn still has. `VOLATILE_MARKER` is the same boundary
    // the prompt-cache split cuts on, so the two can't drift. The worker hands
    // a resumed run only the parts carrying the marker (`stableFirst`), so the
    // stable vault, bridge and skill-index blocks stay in the snapshot.
    if (resume && !resume.isFirstRun && systemMessages.length > 0) {
      const joined = systemMessages.join('\n');
      const marker = joined.match(VOLATILE_MARKER);
      // No marker: a caller that did not split its parts. Send all of it
      // rather than guess where the boundary is.
      const volatile = (marker?.index !== undefined ? joined.slice(marker.index) : joined).trim();
      if (volatile) prompt = `${volatile}\n\n---\n\n${prompt}`;
    }

    if (IS_WIN || connection) {
      args.push('-p', '--verbose', '--output-format', 'stream-json');
    } else {
      args.push('-p', prompt, '--verbose', '--output-format', 'stream-json');
    }

    // Claude is the only CLI that lets the caller mint the id, so the first
    // run declares it and every later run resumes it. Nothing has to be
    // scraped, and there is no window in which a run has no id.
    if (resume) {
      args.push(resume.isFirstRun ? '--session-id' : '--resume', resume.id);
    }

    // Note: do NOT pass --bare. It explicitly disables OAuth and keychain
    // reads ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper"),
    // which makes the spawned subprocess return "Not logged in · Please run
    // /login" for users authenticated via `claude login` (OAuth). Plugin/hook
    // leakage from the host config is the accepted trade-off.

    // Shared 'safe'|'workspace'|'full' levels translate per adapter (C14);
    // native Claude modes pass through, codex-style values throw.
    // In a space, and on a personal row: `default`, so every non-read native
    // tool use asks Octipus through the stdio permission tool (CLI_SPACE_MODES).
    args.push('--permission-mode', connection?.planMode ? 'plan' : lockedRun(connection) ? 'default' : resolveClaudePermissionMode(settings.permissionMode));

    // Model override: env var > settings > vendor default. Vendor accepts an
    // alias ('sonnet', 'opus') or a full model id ('claude-sonnet-4-6').
    // https://code.claude.com/docs/en/cli-reference
    const claudeModel = process.env.CLAUDE_MODEL || settings.model;
    if (claudeModel) {
      args.push('--model', claudeModel);
    }

    // Claude records the system prompt on the first request and replays it
    // verbatim on every resume (--system-prompt-snapshot on, the default);
    // re-appending it on a resume would stack a second copy.
    if (systemMessages.length > 0 && (!resume || resume.isFirstRun)) {
      const sysPrompt = systemMessages.join('\n');
      if (IS_WIN) {
        // Write to temp file to avoid Windows command-line length limit (~8191 chars)
        const tmpFile = this.writeTempFile('claude-sys-', sysPrompt);
        args.push('--append-system-prompt-file', tmpFile);
      } else {
        args.push('--append-system-prompt', sysPrompt);
      }
    }

    // MCP config: a live bridge registers the scoped octipus server;
    // otherwise an explicit operator setting, or — with neither — an empty
    // config, since there is no bridge to point `octipus` at (zero MCP
    // servers, not the host's ~/.claude.json set). --strict-mcp-config is
    // unconditional so a failed/absent bridge can never fall through to the
    // host's own MCP config.
    const mcpConfig = connection
      ? getOrCreateMcpConfig(agentId, connection)
      : (settings.mcpConfigPath || getEmptyMcpConfigPath());
    args.push('--strict-mcp-config');
    if (connection) {
      if (Number.isFinite(connection.maxIterations)) args.push('--max-turns', String(connection.maxIterations));
      args.push('--input-format', 'stream-json', '--replay-user-messages', '--permission-prompt-tool', 'stdio');
    }
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig);
    }

    // Pre-approved tools skip the permission tool: none in a space or on a personal row.
    if (settings.allowedTools?.length && !lockedRun(connection)) {
      args.push('--allowedTools', ...settings.allowedTools);
    }

    if (settings.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(settings.maxBudgetUsd));
    }

    // Delegation goes through Octipus spawn_child only: native subagents
    // (`Agent`, legacy name `Task`) live inside this process, so background
    // ones die silently when it exits. One merged flag keeps operator disallows.
    const { disallowed, rest } = splitClaudeDisallowedTools(settings.extraArgs ?? []);
    args.push('--disallowedTools', [...new Set([...disallowed, ...CLAUDE_NATIVE_SUBAGENT_TOOLS])].join(','));

    // In a space and on a personal row: no settings file but ours
    // (`getClaudeSpaceSettingsPath`), so the owner's cli-home settings
    // (allow rules, hooks) never pre-approve a native tool.
    // `=` form: an empty value survives a shell-wrapped Windows launch.
    // Otherwise a per-launch layer that merges over the user's, never writes it.
    if (lockedRun(connection)) args.push('--setting-sources=', '--settings', getClaudeSpaceSettingsPath(!!connection?.shellGuard));
    else if (connection?.shellGuard) args.push('--settings', getClaudeShellGuardSettingsPath());

    if (rest.length) {
      args.push(...rest);
    }

    const content = connection?.images?.length
      ? [{ type: 'text', text: prompt }, ...connection.images.map(image => ({
          type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data },
        }))]
      : prompt;
    return { binary: 'claude', args, keepStdinOpen: !!connection,
      ...(connection ? { env: { MCP_TOOL_TIMEOUT: String(CLI_BRIDGE_TOOL_TIMEOUT_SECONDS * 1000) } } : {}),
      stdinPrompt: connection ? JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n' : IS_WIN ? prompt : undefined };
  }

  private buildAntigravityArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemPrompt?: string | null,
    connection?: CliRunConnection,
  ): { binary: string; args: string[]; useShell?: boolean } {
    // agy (Antigravity) replaces the Gemini CLI. `--print <prompt>` runs a
    // single prompt non-interactively and emits PLAIN TEXT (no -o json /
    // stream-json), which the worker buffers via CLIToolConfig.bufferOutput.
    // --dangerously-skip-permissions auto-approves tool calls (the agy
    // equivalent of gemini's --approval-mode yolo).
    const args: string[] = [];
    if (connection?.planMode || lockedRun(connection) || settings.permissionMode === 'safe' || settings.permissionMode === 'plan') args.push('--mode', 'plan');
    else if (['workspace', 'accept-edits', 'auto_edit', 'auto'].includes(settings.permissionMode ?? '')) args.push('--mode', 'accept-edits', '--sandbox');
    else if (!settings.permissionMode || settings.permissionMode === 'full' || settings.permissionMode === 'yolo') args.push('--dangerously-skip-permissions');
    else throw new Error(`Unsupported Antigravity permission mode: ${settings.permissionMode}`);

    // Model override: env var > settings. agy uses --model (not gemini's -m);
    // when unset, agy picks the model from its own ~/.gemini config.
    const model = process.env.ANTIGRAVITY_MODEL || process.env.GEMINI_MODEL || settings.model;
    if (model) {
      args.push('--model', model);
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // agy reads hooks only from customization roots; an added workspace dir
    // is one, so the guard rides in without touching ~/.gemini or the project.
    if (connection?.shellGuard) args.push('--add-dir', getAgyShellGuardDir());

    // agy has no --system-prompt flag, and text-mode --print takes no stdin
    // (only --input-format stream-json, which forces stream-json output).
    // Prepend the expert system prompt to the user prompt; the spawn sites
    // guard the Windows command-line cap (assertWindowsCmdLineFits).
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    args.push('--print', fullPrompt);

    // agy is a native single binary (not a .cmd wrapper), so the worker must
    // NOT shell-wrap it on Windows — shell:true would re-tokenize the prompt
    // argv. Passing useShell:false keeps the prompt a single argv element.
    return { binary: 'agy', args, useShell: false };
  }

  /**
   * Write content to a temp file, returning the path.
   * Used on Windows to bypass the ~8191-char command-line limit.
   */
  private writeTempFile(prefix: string, content: string, ext: string = '.txt'): string {
    const dir = join(tmpdir(), 'octipus-cli');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${prefix}${randomBytes(6).toString('hex')}${ext}`);
    writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });
    return filePath;
  }

  private buildCodexArgs(
    prompt: string,
    systemPrompt?: string | null,
    settings?: CLIAgentConfig,
    connection?: CliRunConnection,
    resume?: { id: string; isFirstRun: boolean },
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Codex: positional prompt or '-' to read from stdin.
    // Multi-line prompts or oversized args break the positional path —
    // codex prints "Reading additional input from stdin..." then exits 1 when
    // the argv text contains newlines. Always pipe via stdin in that case.
    // Short single-line prompts may still go as a positional.
    //
    // Model selection is the user's codex choice. Only inject `-c
    // model="<name>"` when an override is set explicitly (CODEX_MODEL env or
    // the model row); otherwise let codex resolve the model from its own
    // ~/.codex/config.toml. Do NOT hardcode a default here — a stale guess
    // (e.g. a model the user's plan can't use) makes every codex spawn exit 1
    // server-side, which is exactly the failure this used to cause.
    const modelOverride = process.env.CODEX_MODEL || settings?.model;
    // Sandbox / approval policy: codex `exec` defaults to `--sandbox
    // read-only`, so spawned agents (e.g. pipeline architecture stages)
    // cannot write the ADRs / docs they produce. Mirror the write-enabled
    // defaults the Claude (`bypassPermissions`) and Gemini (`yolo`) CLI
    // adapters already use. Operators can downgrade to read-only by
    // setting permissionMode='read-only' on the model row.
    // Sandbox policy: `codex exec` is non-interactive (no approval prompts
    // to suppress) but it does honor `--sandbox`. Default is read-only,
    // which blocks pipeline stages from writing the docs/code they
    // produce — see Claude (`bypassPermissions`) and Gemini (`yolo`)
    // adapters above for the write-enabled equivalents. Operators can
    // dial back per-model via `permissionMode` on the model row.
    // A space or personal-row run is read-only (CLI_SPACE_MODES): writes go through Octipus tools.
    const codexPermMode = connection?.planMode || lockedRun(connection) ? 'read-only' : resolveCodexSandboxMode(settings?.permissionMode);
    // resume.id present with isFirstRun false: continue that thread via
    // `codex exec resume <id>`. Otherwise (including the first run, which has
    // no id yet) --ephemeral is dropped whenever `resume` participates in
    // reuse, since an ephemeral run can never be resumed later.
    const isResumedRun = !!resume && !resume.isFirstRun;
    const baseArgs = isResumedRun ? ['exec', 'resume', resume.id] : ['exec'];
    baseArgs.push('--skip-git-repo-check', '--json');
    if (!resume) baseArgs.push('--ephemeral');
    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` (v0.154.0) does NOT
    // accept --sandbox — verified live 2026-09-16: `error: unexpected
    // argument '--sandbox' found`, usage line confirms its only options are
    // -c/--config, --last, --all, --enable, --disable, -i/--image,
    // --strict-config (plus --skip-git-repo-check/--json handled above).
    // `-c sandbox_mode="<mode>"` is accepted on resume (config-override
    // escape hatch) and was confirmed working by hand:
    // `codex exec resume <id> --skip-git-repo-check --json -c sandbox_mode="read-only" "..."`.
    // A first/non-resumed `exec` run still takes --sandbox directly.
    if (isResumedRun) baseArgs.push('-c', `sandbox_mode="${codexPermMode}"`);
    else baseArgs.push('--sandbox', codexPermMode);
    // Config overrides are accepted by both exec and exec resume; --add-dir
    // is not accepted by resume. Read-only/space/personal-row modes stay locked.
    if (codexPermMode === 'workspace-write' && !lockedRun(connection) && connection?.writableRuntimePaths?.length) {
      baseArgs.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(connection.writableRuntimePaths)}`);
    }
    // Delegation goes through Octipus spawn_child only. Accepted by both
    // `exec` and `exec resume` (verified on 0.154.0, `codex features list`).
    for (const feature of CODEX_NATIVE_SUBAGENT_FEATURES) baseArgs.push('--disable', feature);
    if (connection) {
      // Codex merges -c tables, so never overlay a host HTTP/stdio entry.
      // Ask Codex to resolve every config layer, including trusted project
      // directories. Preserve CODEX_HOME and its subscription authentication.
      // Discovery is async and runs in the worker before build (see CLIAgentWorker).
      const configured = connection.codexMcpServers;
      if (!configured) throw new Error('Scoped Codex launch requires discovered MCP configuration; refusing to launch an unscoped CLI run');
      const disabled = configured.map(server => `${JSON.stringify(server.name)}={enabled=false}`);
      const entry = resolveCliMcpEntry();
      // Only this private server is auto-approved by Codex: Octipus's native
      // executor remains responsible for every tool's actual authorization.
      const server = `{ command = ${JSON.stringify(process.execPath)}, args = [${JSON.stringify(entry)}], env_vars = ["OCTIPUS_AGENT_URL", "OCTIPUS_AGENT_KEY"], default_tools_approval_mode = "approve", tool_timeout_sec = ${CLI_BRIDGE_TOOL_TIMEOUT_SECONDS} }`;
      const namespace = `octipus_run_${createHash('sha256').update(connection.conversationId ?? connection.url).digest('hex').slice(0, 16)}`;
      if (configured.some(s => s.name === namespace)) throw new Error('Octipus MCP namespace conflicts with host configuration');
      baseArgs.push('-c', `mcp_servers={${[...disabled, `${namespace}=${server}`].join(',')}}`);
    } else {
      // No bridge (never started, or failed) — no discovered server list to
      // disable by name, and `-c mcp_servers={}` alone does NOT disable
      // configured servers (verified live 2026-09-16: codex MERGES -c
      // tables into config.toml rather than replacing them, same reason the
      // connected branch above enumerates every server instead of just
      // overlaying the octipus entry). `--ignore-user-config` skips
      // config.toml entirely (auth still resolves via CODEX_HOME), which is
      // the only way to reach zero MCP servers without a discovered list.
      // Trade-off: an implicit default model set only in config.toml (no
      // CODEX_MODEL/settings.model override) is lost for this run — an
      // acceptable cost for a run with no working tool bridge anyway.
      baseArgs.push('--ignore-user-config');
    }
    if (connection?.shellGuard) {
      // Hooks from -c are untrusted until reviewed in the TUI, and exec skips
      // untrusted hooks silently (verified live on 0.158.0), hence the bypass.
      // Windows: codex.cmd re-parses %* through cmd.exe, so the value stays free
      // of `"`, spaces and `|` rather than leaning on quoting (it once exited 255):
      // TOML literal strings, no matcher (the script ignores calls without a
      // command), a .cmd wrapper.
      const hook = IS_WIN
        ? `{hooks=[{type='command',command='${getCodexShellGuardWrapper()}'}]}`
        : `{ matcher = ${JSON.stringify(SHELL_GUARD_TOOL_MATCHER)}, hooks = [{ type = "command", command = ${JSON.stringify(shellGuardHookCommand())} }] }`;
      baseArgs.push('--dangerously-bypass-hook-trust', '-c', `hooks.PreToolUse=[${hook}]`);
    }
    for (const image of connection?.images ?? []) baseArgs.push('--image', image.path);
    if (modelOverride) baseArgs.push('-c', `model="${modelOverride}"`);
    if (settings?.extraArgs?.length) baseArgs.push(...settings.extraArgs);

    if (systemPrompt) {
      const boundary = systemPrompt.match(VOLATILE_MARKER)?.index;
      const instructions = isResumedRun && boundary !== undefined ? systemPrompt.slice(boundary) : isResumedRun ? '' : systemPrompt;
      const combined = [instructions, prompt].filter(Boolean).join('\n\n---\n\n');
      return { binary: 'codex', args: [...baseArgs, '-'], stdinPrompt: combined };
    }

    const needsStdin = IS_WIN || prompt.includes('\n') || prompt.length > 1024;
    if (needsStdin) {
      return { binary: 'codex', args: [...baseArgs, '-'], stdinPrompt: prompt };
    }
    return { binary: 'codex', args: [...baseArgs, prompt] };
  }
}

/** Callbacks the worker wires into the parser. */
export interface CLIParserCallbacks {
  /** Public assistant text confirmed to precede further work, never reasoning. */
  onCommentary?: (text: string) => void;
  /**
   * A model turn started (codex `turn.started`, a new Claude assistant
   * message). The worker uses this as the iteration counter — turns, not
   * tool calls (C15).
   */
  onTurn: () => void;
  /** A tool invocation was observed (separate from turns). */
  onToolCall?: () => void;
  /** Bridge calls are tallied by the native executor, not the outer MCP envelope. */
  isBridgedTool?: (name: string) => boolean;
  /**
   * Incremental token usage (codex per-turn `turn.completed`, Claude
   * per-assistant-message usage + final `result` reconciliation). Fires
   * per turn so the worker's budget-kill can trigger mid-run (C16).
   */
  onTokenUsage?: (tokens: { input: number; output: number; total: number; cacheRead?: number; cacheCreation?: number }) => void;
  /** Authoritative final turn count (Claude `result.num_turns`). */
  onTurnCount?: (turns: number) => void;
  /**
   * The CLI reported the run failed (Claude `error_max_turns` /
   * `error_during_execution` / `is_error`, codex `turn.failed` / `error`).
   * The worker must surface a failed status, never success (C3).
   */
  onRunError?: (reason: string) => void;
  /**
   * The vendor's session/thread id (Codex `thread.started.thread_id`).
   * Invoked once per run with the vendor's id for resume support.
   */
  onVendorSession?: (id: string) => void;
  /** Claude's `system/init`: the vendor has opened (or reopened) the session. */
  onSessionInit?: () => void;
  /**
   * The vendor's subscription allowance as of this run (muse `usage/changed`,
   * or a quota-stopped turn at 100 %): the highest used share of its windows,
   * and when the fullest one resets.
   */
  onAllowance?: (allowance: { usedPercent: number; resetsAt?: Date }) => void;
  /**
   * The vendor answered this run's prompt (a Claude `assistant` message, a
   * Codex `item.*` event). A vendor writes the prompt into its conversation
   * before it starts answering, so from here on a resume holds this turn.
   */
  onVendorReply?: () => void;
}

/**
 * System parts with every stable part ahead of every volatile tail.
 *
 * Each part is split at `VOLATILE_MARKER`: what precedes the marker is stable
 * (fingerprinted, recorded once in a vendor's first-run prompt), the marker
 * and what follows is per turn. A part without a marker is entirely stable —
 * the worker's own vault, bridge and skill-index blocks. Before this they
 * followed the root prompt's volatile tail, so a resumed turn, which re-sends
 * everything from the marker on, sent them again every turn.
 */
export function stableFirst(parts: readonly string[]): string[] {
  const stable: string[] = [];
  const tails: string[] = [];
  for (const part of parts) {
    const at = part.match(VOLATILE_MARKER)?.index;
    if (at === undefined) { stable.push(part); continue; }
    if (at > 0) stable.push(part.slice(0, at));
    tails.push(part.slice(at));
  }
  return [...stable, ...tails];
}

/**
 * Parses streaming JSON output from CLI agent tools into octipus agent events.
 *
 * Event contract (consumed by web chat + TUI gateway-adapter):
 *   cli_tool_use    { id, toolName, title?, args }
 *   cli_tool_result { id, toolName, args?, output, exitCode?, isError }
 *   file_change     { action, path (absolute), content?, oldContent?, diff? }
 * Ids are the CLI's own stable ids (Claude `tool_use.id`, codex `item.id`) so
 * start/result rows pair up in every UI (C1/C2/C9).
 */
/** Native Claude command tools. Codex is counted by its command_execution event,
 * never the display label inferred from shell text. */
const CLI_COMMAND_TOOLS = new Set(['Bash', 'shell']);
/** Claude tools whose `run_in_background` work outlives the tool_result and dies with the process. */
const CLAUDE_BACKGROUND_TOOLS = new Set(['Agent', 'Task', 'Bash']);

export class CLIOutputParser {
  private pendingCommentary?: { id: string; text: string };
  private publishedCommentary = new Set<string>();

  private rememberCommentary(id: string, text: string): void {
    if (this.publishedCommentary.has(id)) return;
    if (this.pendingCommentary && this.pendingCommentary.id !== id) this.flushCommentary();
    if (text.trim() && !this.publishedCommentary.has(id)) this.pendingCommentary = { id, text };
  }

  private flushCommentary(): void {
    const pending = this.pendingCommentary;
    this.pendingCommentary = undefined;
    if (!pending || this.publishedCommentary.has(pending.id)) return;
    this.publishedCommentary.add(pending.id);
    this.callbacks.onCommentary?.(pending.text);
  }
  /** tool id → tool name, so results can carry the real name (C9). */
  private toolNamesById = new Map<string, string>();
  /** codex item ids we already emitted a cli_tool_use for. */
  private startedItemIds = new Set<string>();
  /** Claude assistant message ids already counted as turns. */
  private seenClaudeMessageIds = new Set<string>();
  /** Tokens already reported via onTokenUsage (for final reconciliation). */
  private reportedTokens = 0;
  /**
   * Per-field running totals already reported via onTokenUsage — mirrors
   * `reportedTokens` but broken out by field, so the `result`-event fallback
   * below can emit a DELTA for every field it carries, not just `total`.
   * Updated by both `reportClaudeUsage` (per-message) and the `result`
   * fallback itself, so whichever fires first is accounted for by the next.
   * `input` here is the raw combined figure (fresh + cache read + cache
   * creation), matching what the `input` field on the callback has always
   * meant.
   */
  private reportedInput = 0;
  private reportedOutput = 0;
  private reportedCacheRead = 0;
  private reportedCacheCreation = 0;
  /**
   * Deterministic side-effect tally for this CLI run. A CLI writes files in its
   * OWN process, so octipus never sees those writes through a `ToolExecutor` —
   * the stream is the only ground truth we have. Counted from the events we
   * already parse, never inferred from the CLI's prose.
   */
  private counters: SideEffectCounters = emptyCounters();
  private claudeUsageByMessage = new Map<string, { freshInput: number; cacheRead: number; cacheCreation: number; output: number }>();
  /**
   * Did we parse a stream shape we actually understand? Only `Claude Code` and
   * `Codex CLI` stream structured events; a buffered-output tool (agy) yields
   * no events at all. Its counters would read as all-zero — indistinguishable
   * from "did nothing" — so `getSideEffectCounters` reports null (unknown)
   * instead. A wrong zero is worse than no evidence: it fails work that
   * actually succeeded.
   */
  private streamRecognized = false;
  /** Claude background work (tool_use id → description) with no terminal task_notification yet. */
  private openBackground = new Map<string, string>();
  /** Claude task_id → tool_use_id, for notifications that omit tool_use_id. */
  private backgroundTaskIds = new Map<string, string>();

  constructor(
    private agentId: string,
    private model: string,
    private emitFn: (type: AgentEvent['type'], data: unknown) => void,
    private callbacks: CLIParserCallbacks,
    /** Agent working directory — file_change paths are resolved against it (P1.9). */
    private workspaceCwd: string = process.cwd(),
  ) {}

  /** Resolve a (possibly relative) path from CLI output against the agent cwd. */
  private absPath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.workspaceCwd, p);
  }

  /**
   * Every parser emission funnels through here so the side-effect tally is
   * maintained at ONE chokepoint — a new `cli_tool_use`/`file_change` emitter
   * (there are already 5 across the two vendors) is counted automatically
   * instead of silently skipping the tally.
   */
  private emit(type: AgentEvent['type'], data: unknown): void {
    const d = data as { type?: string; toolName?: string; isError?: boolean; commandExecution?: boolean } | null;
    const bridged = !!d?.toolName && this.callbacks.isBridgedTool?.(d.toolName);
    if (bridged) { this.emitFn(type, data); return; }
    switch (d?.type) {
      case 'cli_tool_use':
        if (d.commandExecution || CLI_COMMAND_TOOLS.has(d.toolName ?? '')) this.counters.commandsRun++;
        this.counters.byName[d.toolName || 'tool'] = (this.counters.byName[d.toolName || 'tool'] ?? 0) + 1;
        break;
      case 'cli_tool_result':
        if (d.isError) this.counters.toolErrors++;
        break;
      case 'file_change':
        this.counters.filesChanged++;
        break;
    }
    this.emitFn(type, data);
  }

  /**
   * Deterministic side-effect counters for this CLI run, or `null` when the
   * stream shape was never recognized (see `streamRecognized`). `toolCalls`
   * is derived from `byName`; commands are counted from execution events,
   * independently of presentation labels. `filesChanged` uses `file_change` emissions,
   * which BOTH vendors route through `emitFileChange`.
   */
  /** Background tasks the CLI started and never reported finished; they die with the process. */
  getOpenBackgroundTasks(): string[] {
    return [...this.openBackground.values()];
  }

  getSideEffectCounters(): SideEffectCounters | null {
    if (!this.streamRecognized) return null;
    const byName = { ...this.counters.byName };
    let toolCalls = 0;
    for (const n of Object.values(byName)) toolCalls += n;
    return { ...this.counters, toolCalls, byName };
  }

  private emitFileChange(change: { action: string; path: string; content?: string; oldContent?: string; diff?: { patch: string; added: number; removed: number } }): void {
    this.emit('action', {
      type: 'file_change',
      ...change,
      path: this.absPath(change.path),
    });
  }

  /**
   * Process a streaming JSON event from the CLI binary.
   * Returns { text, replace } — text to add, replace=true means reset accumulated text.
   */
  parse(event: Record<string, unknown>, toolName: string): { text: string; replace?: boolean } | null {
    const type = event.type as string;

    if (toolName === 'Claude Code') {
      this.streamRecognized = true;
      return this.parseClaudeEvent(event, type);
    }

    // Antigravity (agy) emits plain text buffered at process close
    // (CLIToolConfig.bufferOutput), so it has no per-event stream parser here.

    if (toolName === 'Codex CLI') {
      this.streamRecognized = true;
      return this.parseCodexEvent(event, type);
    }

    if (toolName === 'Muse Code') {
      this.streamRecognized = true;
      return this.parseMuseEvent(event);
    }

    return null;
  }

  /** The current muse agent message (item id + text so far). */
  private museTurn?: { id: string; text: string };
  /** Started muse tool calls without a result (item ids). */
  private museOpenTools = new Set<string>();
  private museReplied = false;

  private parseMuseEvent(event: Record<string, unknown>): { text: string; replace?: boolean } | null {
    // `muse serve` (MSP, JSON-RPC 2.0) messages read here:
    //   error responses                       a refused initialize / session open / turn
    //   turn/started                          the session holds this run's prompt
    //   turn/modelAttemptStarted              one model call
    //   item/started|completed { item: { itemId, kind: "toolCall", tool, status, visibleOutput, failureReason } }
    //   item/started|completed { item: { itemId, kind: "agentMessage", text } }, item/delta { itemId, field?, delta }
    //   session/tokenUsage { usage: { inputTokens, cachedTokens, outputTokens } }   per model call
    //   usage/changed { window, weekly: { usedPercent, resetsAtMs } }
    //   turn/completed { terminal, error?: { message, quota? }, reason? }
    // A muse run has no native tools (`prepareMuseHome`): every tool is an Octipus bridge tool.
    const fail = (reason: string) => { this.emit('error', { error: reason }); this.callbacks.onRunError?.(reason); };
    const replied = () => { if (!this.museReplied) { this.museReplied = true; this.callbacks.onVendorReply?.(); } };
    const error = event.error as { message?: unknown; data?: { kind?: unknown; reason?: unknown } } | undefined;
    // The typed kind (`sessionNotFound` → the worker's cold retry) before the text.
    if (error) { fail(`Muse Code refused the run (${[error.data?.kind, error.data?.reason].filter(Boolean).map(String).join(': ') || 'error'}): ${String(error.message ?? 'unknown error')}`); return null; }
    if (typeof event.method !== 'string') return null;
    if (event.id !== undefined) { fail(`Muse Code asked for ${event.method}, which an Octipus run does not answer`); return null; }
    const params = (event.params ?? {}) as Record<string, unknown>;
    const item = (params.item ?? {}) as Record<string, unknown>;
    const itemId = typeof item.itemId === 'string' ? item.itemId : '';
    const startTool = () => {
      replied();
      this.flushCommentary();
      this.callbacks.onToolCall?.();
      this.museOpenTools.add(itemId);
      this.emit('action', { type: 'cli_tool_use', id: itemId || undefined, toolName: String(item.tool ?? 'tool') });
    };

    switch (event.method) {
      case 'turn/started':
        this.callbacks.onSessionInit?.();
        return null;
      case 'turn/modelAttemptStarted':
        this.callbacks.onTurn();
        return null;
      case 'item/started':
        if (item.kind === 'toolCall') startTool();
        else if (item.kind === 'agentMessage') this.museTurn = { id: itemId, text: '' };
        return null;
      case 'item/delta': {
        const turn = this.museTurn;
        if (!turn || params.itemId !== turn.id || (params.field ?? 'text') !== 'text' || typeof params.delta !== 'string') return null;
        replied();
        const first = !turn.text;
        turn.text += params.delta;
        this.rememberCommentary(turn.id, turn.text);
        return { text: params.delta, replace: first };
      }
      case 'item/completed':
        if (item.kind === 'toolCall') {
          // A call muse refused before it ran (an unknown tool) completes without a start.
          if (!this.museOpenTools.has(itemId)) startTool();
          this.museOpenTools.delete(itemId);
          this.emit('action', { type: 'cli_tool_result', id: itemId || undefined, toolName: String(item.tool ?? 'tool'),
            output: String(item.visibleOutput ?? item.failureReason ?? item.status ?? '').slice(0, 2000), isError: item.status !== 'completed' });
        } else if (item.kind === 'agentMessage' && typeof item.text === 'string' && item.text) {
          replied();
          this.museTurn = { id: itemId, text: item.text };
          this.rememberCommentary(itemId, item.text);
          return { text: item.text, replace: true };
        }
        return null;
      case 'session/tokenUsage': {
        const raw = params.usage as Record<string, unknown> | undefined;
        const usage = museUsage(raw ? [{ input_tokens: raw.inputTokens, cached_tokens: raw.cachedTokens, output_tokens: raw.outputTokens }] : undefined);
        if (!usage) return null;
        const totalTokens = usage.inputTokens + usage.outputTokens;
        this.emit('thought', { status: 'completed', stats: { totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheRead: usage.cacheReadTokens } });
        this.reportedTokens += totalTokens;
        this.callbacks.onTokenUsage?.({ input: usage.inputTokens, output: usage.outputTokens, total: totalTokens, cacheRead: usage.cacheReadTokens });
        return null;
      }
      case 'usage/changed': {
        const allowance = museAllowance(params);
        if (allowance) this.callbacks.onAllowance?.(allowance);
        return null;
      }
      case 'turn/completed':
        if (params.terminal !== 'completed') {
          const turnError = params.error as { message?: unknown; quota?: { resetsAtMs?: unknown } } | undefined;
          // A typed quota stop: the allowance is spent until the reported reset.
          if (turnError?.quota) this.callbacks.onAllowance?.({ usedPercent: 100, ...(typeof turnError.quota.resetsAtMs === 'number' ? { resetsAt: new Date(turnError.quota.resetsAtMs) } : {}) });
          fail(`Muse Code run ${String(params.terminal ?? 'failed')}: ${String(turnError?.message ?? params.reason ?? 'unknown reason')}`);
        }
        return null;
      default:
        return null;
    }
  }

  private parseClaudeEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Claude Code stream-json format:
    // { type: "system", subtype: "init" }
    // { type: "assistant", message: { id, content: [{ type: "tool_use", id, name, input }, { type: "text", text }], usage } }
    // { type: "user", message: { content: [{ type: "tool_result", tool_use_id, content, is_error }] } }
    // { type: "result", subtype: "success"|"error_max_turns"|"error_during_execution", is_error, result, num_turns, duration_ms, usage }

    if (type === 'system') {
      const subtype = event.subtype as string | undefined;
      if (subtype === 'init') {
        this.emit('thought', {
          status: 'running',
          vendorSessionId: event.session_id,
        });
        this.callbacks.onSessionInit?.();
      }
      // Shapes read from the claude 2.1.280 binary: task_started carries
      // task_id + tool_use_id, task_notification (terminal) carries task_id and
      // usually tool_use_id.
      if (subtype === 'task_started' && event.tool_use_id && event.task_id) {
        this.backgroundTaskIds.set(event.task_id as string, event.tool_use_id as string);
      }
      if (subtype === 'task_notification') {
        const toolUseId = (event.tool_use_id as string | undefined) ?? this.backgroundTaskIds.get(event.task_id as string);
        if (toolUseId) this.openBackground.delete(toolUseId);
      }
      return null;
    }

    if (type === 'assistant') {
      this.callbacks.onVendorReply?.();
      const message = event.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      // A new assistant message = a new model turn (deduped by message id —
      // stream-json can re-emit the same message across partials).
      const messageId = message?.id as string | undefined;
      const publicText = content.filter(b => b.type === 'text').map(b => b.text as string).join('');
      this.rememberCommentary(messageId ?? `claude-${this.seenClaudeMessageIds.size}-${publicText}`, publicText);
      if (content.some(b => b.type === 'tool_use')) this.flushCommentary();
      if (!messageId || !this.seenClaudeMessageIds.has(messageId)) {
        if (messageId) this.seenClaudeMessageIds.add(messageId);
        this.callbacks.onTurn();
      }

      // Emit tool_use events — carrying Claude's own tool_use.id so the
      // matching tool_result (type:"user") flips the same row (C1).
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolUseId = (block.id || '') as string;
          const toolName = block.name as string;
          if (toolUseId && this.toolNamesById.has(toolUseId)) continue;
          this.callbacks.onToolCall?.();
          if (toolUseId) this.toolNamesById.set(toolUseId, toolName);
          const input = (block.input || {}) as Record<string, unknown>;
          if (toolUseId && input.run_in_background === true && CLAUDE_BACKGROUND_TOOLS.has(toolName)) {
            this.openBackground.set(toolUseId, `${toolName}: ${String(input.description || input.command || toolUseId).slice(0, 120)}`);
          }
          this.emit('action', {
            type: 'cli_tool_use',
            id: toolUseId || undefined,
            toolName,
            args: block.input,
          });
          this.emitClaudeFileChanges(toolName, input);
        }
      }

      // Per-message usage — lets the token budget fire mid-run (C16).
      this.reportClaudeUsage(message?.usage as Record<string, unknown> | undefined, messageId);

      // Extract text content
      const texts = content
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('');

      return texts ? { text: texts, replace: true } : null;
    }

    if (type === 'user') {
      // Tool results ride user-role messages as tool_result blocks (C1).
      const message = event.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = (block.tool_use_id || '') as string;
        const isError = block.is_error === true;
        // A background launch that errored never started.
        if (isError) this.openBackground.delete(toolUseId);
        this.emit('action', {
          type: 'cli_tool_result',
          id: toolUseId || undefined,
          toolName: this.toolNamesById.get(toolUseId) || 'tool',
          output: claudeToolResultText(block.content).slice(0, 2000),
          isError,
        });
      }
      return null;
    }

    if (type === 'result') {
      const result = typeof event.result === 'string' ? event.result : '';
      const vendorErrors = Array.isArray(event.errors)
        ? event.errors.filter((error): error is string => typeof error === 'string').map(error => redactedCommand(error)).join('\n') : '';
      const subtype = event.subtype as string | undefined;
      const isError = event.is_error === true || (typeof subtype === 'string' && subtype.startsWith('error'));
      const numTurns = event.num_turns as number | undefined;
      const durationMs = event.duration_ms as number | undefined;
      const totalCostUsd = event.total_cost_usd as number | undefined;

      // Extract token stats
      const usage = event.usage as Record<string, unknown> | undefined;
      const inputTokens = (usage?.input_tokens || 0) as number;
      const outputTokens = (usage?.output_tokens || 0) as number;
      const cacheRead = (usage?.cache_read_input_tokens || 0) as number;
      const cacheCreation = (usage?.cache_creation_input_tokens || 0) as number;

      const totalTokens = inputTokens + outputTokens + cacheRead + cacheCreation;
      if (typeof numTurns === 'number') this.callbacks.onTurnCount?.(numTurns);
      this.emit('thought', {
        status: isError ? 'failed' : 'completed',
        vendorSessionId: event.session_id,
        stats: {
          totalTokens,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheCreation,
          durationMs,
          numTurns,
          totalCostUsd,
        },
      });
      // Final reconciliation: report only what per-message usage didn't
      // already account for, so the running total never double-counts.
      // Per-process only (Task 7 fix round 1): whatever the vendor reports
      // here is what THIS process actually saw and was charged for —
      // cross-process subtraction against a resumed session was tried and
      // reverted (see task-7-report.md) because it has no floor and can
      // collapse the billed total on an ordinary, growing conversation.
      const delta = Math.max(0, totalTokens - this.reportedTokens);
      if (delta > 0) {
        this.reportedTokens += delta;
        // Task 7 fix round 2: every field on this callback must mean the
        // same thing — a delta — or a consumer that bills off input/output/
        // cacheRead (billableTokens) double-charges the whole run whenever
        // this fallback fires. `input` is the raw combined figure (fresh +
        // cache read + cache creation), matching what per-message tracking
        // (`reportClaudeUsage`) has always emitted for that field.
        const rawInput = inputTokens + cacheRead + cacheCreation;
        const inputDelta = Math.max(0, rawInput - this.reportedInput);
        const outputDelta = Math.max(0, outputTokens - this.reportedOutput);
        const cacheReadDelta = Math.max(0, cacheRead - this.reportedCacheRead);
        const cacheCreationDelta = Math.max(0, cacheCreation - this.reportedCacheCreation);
        this.reportedInput += inputDelta;
        this.reportedOutput += outputDelta;
        this.reportedCacheRead += cacheReadDelta;
        this.reportedCacheCreation += cacheCreationDelta;
        this.callbacks.onTokenUsage?.({ input: inputDelta, output: outputDelta, total: delta, cacheRead: cacheReadDelta, cacheCreation: cacheCreationDelta });
      }

      if (isError) {
        const reason =
          subtype === 'error_max_turns'
            ? `Claude Code hit the max-turns limit${numTurns != null ? ` (${numTurns} turns)` : ''}`
            : subtype === 'error_during_execution'
              ? 'Claude Code failed during execution'
              : `Claude Code reported an error${subtype ? ` (${subtype})` : ''}`;
        const diagnostics = [result, vendorErrors].filter(Boolean).join('\n');
        this.callbacks.onRunError?.(diagnostics ? `${reason}: ${redactedCommand(diagnostics).slice(0, 16_000)}` : reason);
      }

      return result ? { text: result, replace: true } : null;
    }

    return null;
  }

  /** file_change events for Claude's file tools, incl. MultiEdit/NotebookEdit/Bash (C10). */
  private emitClaudeFileChanges(toolName: string, input: Record<string, unknown>): void {
    const filePath = (input.file_path || input.path || input.notebook_path) as string | undefined;
    switch (toolName) {
      case 'Write': {
        if (!filePath) return;
        const content = input.content as string | undefined;
        const diff = content ? computeLineDiff('', content) : undefined;
        this.emitFileChange({ action: 'write', path: filePath, content, diff: diff && { patch: diff.patch, added: diff.added, removed: diff.removed } });
        return;
      }
      case 'Edit': {
        if (!filePath) return;
        const oldStr = (input.old_string ?? '') as string;
        const newStr = (input.new_string ?? '') as string;
        const diff = computeLineDiff(oldStr, newStr);
        this.emitFileChange({ action: 'edit', path: filePath, content: newStr, oldContent: oldStr, diff: { patch: diff.patch, added: diff.added, removed: diff.removed } });
        return;
      }
      case 'MultiEdit': {
        if (!filePath) return;
        const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
        const oldStr = edits.map((e) => (e.old_string ?? '') as string).join('\n');
        const newStr = edits.map((e) => (e.new_string ?? '') as string).join('\n');
        const diff = computeLineDiff(oldStr, newStr);
        this.emitFileChange({ action: 'edit', path: filePath, content: newStr, oldContent: oldStr, diff: { patch: diff.patch, added: diff.added, removed: diff.removed } });
        return;
      }
      case 'NotebookEdit': {
        if (!filePath) return;
        this.emitFileChange({ action: 'edit', path: filePath, content: input.new_source as string | undefined });
        return;
      }
      case 'Bash': {
        const command = input.command as string | undefined;
        if (!command) return;
        const change = detectFileChangeFromCommand(command);
        if (change) this.emitFileChange(change);
        return;
      }
    }
  }

  /**
   * Report per-assistant-message usage, tracking the running total for the
   * final reconciliation. Tracks fresh input, cache reads and cache
   * creation as separate deltas (not just a combined "input") so the
   * caller can bill fresh + output and treat cache reads/creation as a
   * context-fill signal instead — see `billableTokens` in
   * `src/models/billable-tokens.ts`.
   */
  private reportClaudeUsage(usage: Record<string, unknown> | undefined, messageId?: string): void {
    if (!usage) return;
    const freshInput = (usage.input_tokens || 0) as number;
    const cacheRead = (usage.cache_read_input_tokens || 0) as number;
    const cacheCreation = (usage.cache_creation_input_tokens || 0) as number;
    const output = (usage.output_tokens || 0) as number;
    const previous = messageId ? this.claudeUsageByMessage.get(messageId) : undefined;
    const freshInputDelta = Math.max(0, freshInput - (previous?.freshInput ?? 0));
    const cacheReadDelta = Math.max(0, cacheRead - (previous?.cacheRead ?? 0));
    const cacheCreationDelta = Math.max(0, cacheCreation - (previous?.cacheCreation ?? 0));
    const outputDelta = Math.max(0, output - (previous?.output ?? 0));
    if (messageId) this.claudeUsageByMessage.set(messageId, {
      freshInput: Math.max(freshInput, previous?.freshInput ?? 0),
      cacheRead: Math.max(cacheRead, previous?.cacheRead ?? 0),
      cacheCreation: Math.max(cacheCreation, previous?.cacheCreation ?? 0),
      output: Math.max(output, previous?.output ?? 0),
    });
    const inputDelta = freshInputDelta + cacheReadDelta + cacheCreationDelta;
    const total = inputDelta + outputDelta;
    if (total <= 0) return;
    this.reportedTokens += total;
    // Keep the per-field trackers in step with `reportedTokens` so the
    // `result`-event fallback (above) sees exactly what per-message
    // tracking has already reported, however far it got before that fires.
    this.reportedInput += inputDelta;
    this.reportedOutput += outputDelta;
    this.reportedCacheRead += cacheReadDelta;
    this.reportedCacheCreation += cacheCreationDelta;
    this.callbacks.onTokenUsage?.({ input: inputDelta, output: outputDelta, total, cacheRead: cacheReadDelta, cacheCreation: cacheCreationDelta });
  }

  private parseCodexEvent(event: Record<string, unknown>, type: string): { text: string; replace?: boolean } | null {
    // Codex --json JSONL format:
    //   { type: "thread.started", thread_id }
    //   { type: "turn.started" }
    //   { type: "item.started"|"item.updated"|"item.completed", item: { id, type, ... } }
    //     item types: agent_message{text}, reasoning{text},
    //       command_execution{command, aggregated_output, exit_code, status},
    //       file_change{changes:[{path,kind}], status}, mcp_tool_call{server,tool,status},
    //       web_search{query}, error{message}
    //   { type: "turn.completed", usage: { input_tokens, cached_input_tokens, output_tokens } }
    //   { type: "turn.failed", error: { message } }
    //   { type: "error", message }

    const item = event.item as Record<string, unknown> | undefined;
    if (item && type.startsWith('item.')) this.callbacks.onVendorReply?.();

    if (type === 'thread.started') {
      this.callbacks.onVendorSession?.(event.thread_id as string);
      this.emit('thought', {
        status: 'running',
        vendorSessionId: event.thread_id,
      });
      return null;
    }

    if (type === 'turn.started') {
      this.callbacks.onTurn();
      return null;
    }

    if (type === 'item.started' && item) {
      this.emitCodexItemStart(item);
      return null;
    }

    if (type === 'item.completed' && item) {
      const itemType = item.type as string;
      const itemId = (item.id || '') as string;

      if (itemType === 'agent_message') {
        const text = (item.text || '') as string;
        this.rememberCommentary(itemId || `codex-${text}`, text);
        return text ? { text, replace: true } : null;
      }

      if (itemType === 'reasoning') {
        const text = (item.text || '') as string;
        if (text) this.emit('thought', { text: text.slice(0, 2000) });
        return null;
      }

      // Some item types complete without a preceding item.started — make
      // sure the UI still gets a start row before the result flips it.
      if (!this.startedItemIds.has(itemId)) this.emitCodexItemStart(item);

      if (itemType === 'command_execution') {
        const output = (item.aggregated_output || '') as string;
        const exitCode = item.exit_code as number | null;
        this.emit('action', {
          type: 'cli_tool_result',
          id: itemId || undefined,
          toolName: this.toolNamesById.get(itemId) || detectToolFromCommand((item.command || '') as string),
          args: { command: item.command },
          output: output.slice(0, 2000),
          exitCode,
          isError: typeof exitCode === 'number' && exitCode !== 0,
        });
        return null;
      }

      if (itemType === 'file_change') {
        // Structured apply_patch output — the authoritative file-change
        // source for codex (C2); shell-regex detection only covers ad-hoc
        // `cat >`/`sed -i` commands.
        const changes = Array.isArray(item.changes) ? (item.changes as Array<Record<string, unknown>>) : [];
        const kindMap: Record<string, string> = { add: 'write', update: 'edit', delete: 'delete' };
        for (const change of changes) {
          const path = change.path as string | undefined;
          if (!path) continue;
          this.emitFileChange({ action: kindMap[(change.kind as string) || ''] || 'edit', path });
        }
        const failed = item.status === 'failed';
        this.emit('action', {
          type: 'cli_tool_result',
          id: itemId || undefined,
          toolName: 'apply_patch',
          output: changes.map((c) => `${c.kind ?? 'edit'} ${c.path ?? ''}`).join('\n'),
          isError: failed,
        });
        return null;
      }

      if (itemType === 'mcp_tool_call') {
        const failed = item.status === 'failed';
        this.emit('action', {
          type: 'cli_tool_result',
          id: itemId || undefined,
          toolName: this.toolNamesById.get(itemId) || codexMcpToolName(item),
          output: typeof item.result === 'string' ? (item.result as string).slice(0, 2000) : (failed ? 'failed' : 'ok'),
          isError: failed,
        });
        return null;
      }

      if (itemType === 'web_search') {
        this.emit('action', {
          type: 'cli_tool_result',
          id: itemId || undefined,
          toolName: 'web_search',
          args: { query: item.query },
          output: '',
          isError: false,
        });
        return null;
      }

      if (itemType === 'error') {
        const message = (item.message || 'codex reported an error') as string;
        if (isCodexHookTrustWarning(message)) { this.emit('observation', { warning: message }); return null; }
        this.emit('error', { error: message });
        this.callbacks.onRunError?.(message);
        return null;
      }

      return null;
    }

    if (type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        // Codex reports the OpenAI Responses shape: `cached_input_tokens` is a
        // SUBSET of `input_tokens`, not an extra charge on top — VERIFIED
        // live against codex CLI v0.154.0 on 2026-09-16, not assumed. Two
        // `codex exec --json` turns in one resumed thread:
        //   turn 1 (fresh):   input_tokens=15839, cached_input_tokens=8192
        //   turn 2 (resumed): input_tokens=31694, cached_input_tokens=23808
        // If cached were exclusive (added on top of input), turn 2's prompt
        // would have been 31694+23808=55502 tokens for a two-line
        // conversation — impossible. `input_tokens` also already covers the
        // WHOLE prompt for that turn (not a session-cumulative figure), so
        // no cross-turn subtraction is needed here; that matches the
        // existing per-process reconciliation design below and this file
        // leaves that design unchanged.
        //
        // `foldCacheCounters` is what settles the "subset, not addend"
        // convention, so route through it rather than hand-adding — the
        // emitted fields then satisfy `input + output === total` and
        // `cacheRead <= input`, which the two consumers in
        // cli-agent-worker.ts (the context proxy and `billableTokens`) both
        // assume. Adding `cached` onto `input` while leaving `total` alone
        // broke both: `billableTokens` saw the entire replayed context as
        // fresh spend and the budget kill-switch SIGKILLed a well-cached
        // resumed thread — the failure already fixed for Claude.
        //
        // The fold is also safe if Codex ever reports the counters
        // exclusively: its post-condition clamp raises `inputTokens` to the
        // cache sum rather than letting `cacheRead > input` through.
        const folded = foldCacheCounters({
          input_tokens: usage.input_tokens,
          input_tokens_details: { cached_tokens: usage.cached_input_tokens },
          output_tokens: usage.output_tokens,
        });
        const inputTokens = folded.inputTokens;
        const cachedTokens = folded.cacheReadTokens ?? 0;
        const outputTokens = (usage.output_tokens || 0) as number;
        const totalTokens = inputTokens + outputTokens;
        this.emit('thought', {
          status: 'completed',
          stats: {
            totalTokens,
            inputTokens,
            outputTokens,
            cacheRead: cachedTokens,
          },
        });
        this.reportedTokens += totalTokens;
        this.callbacks.onTokenUsage?.({ input: inputTokens, output: outputTokens, total: totalTokens, cacheRead: cachedTokens });
      }
      return null;
    }

    if (type === 'turn.failed') {
      const error = event.error as Record<string, unknown> | undefined;
      const message = (error?.message || 'codex turn failed') as string;
      this.emit('error', { error: message });
      this.emit('thought', { status: 'failed', error: message });
      this.callbacks.onRunError?.(message);
      return null;
    }

    if (type === 'error') {
      const message = (event.message || 'codex reported an error') as string;
      if (isCodexHookTrustWarning(message)) { this.emit('observation', { warning: message }); return null; }
      this.emit('error', { error: message });
      this.callbacks.onRunError?.(message);
      return null;
    }

    return null;
  }

  /** Emit the cli_tool_use start row for a codex item (idempotent per item id). */
  private emitCodexItemStart(item: Record<string, unknown>): void {
    const itemType = item.type as string;
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(itemType)) this.flushCommentary();
    const itemId = (item.id || '') as string;
    if (itemId && this.startedItemIds.has(itemId)) return;

    if (itemType === 'command_execution') {
      this.callbacks.onToolCall?.();
      const command = (item.command || '') as string;
      const toolName = detectToolFromCommand(command);
      if (itemId) {
        this.startedItemIds.add(itemId);
        this.toolNamesById.set(itemId, toolName);
      }
      this.emit('action', {
        type: 'cli_tool_use',
        id: itemId || undefined,
        toolName,
        commandExecution: true,
        title: titleFromCommand(command),
        args: { command },
      });
      // Shell-level file-change heuristic (`cat > f`, `sed -i`, …) — the
      // structured file_change item covers apply_patch edits only.
      const fileChange = detectFileChangeFromCommand(command);
      if (fileChange) this.emitFileChange(fileChange);
      return;
    }

    if (itemType === 'mcp_tool_call') {
      this.callbacks.onToolCall?.();
      const toolName = codexMcpToolName(item);
      if (itemId) {
        this.startedItemIds.add(itemId);
        this.toolNamesById.set(itemId, toolName);
      }
      this.emit('action', {
        type: 'cli_tool_use',
        id: itemId || undefined,
        toolName,
        args: item.arguments != null ? { arguments: item.arguments } : undefined,
      });
      return;
    }

    if (itemType === 'file_change') {
      this.callbacks.onToolCall?.();
      if (itemId) this.startedItemIds.add(itemId);
      this.emit('action', {
        type: 'cli_tool_use',
        id: itemId || undefined,
        toolName: 'apply_patch',
        args: undefined,
      });
      return;
    }

    if (itemType === 'web_search') {
      this.callbacks.onToolCall?.();
      if (itemId) this.startedItemIds.add(itemId);
      this.emit('action', {
        type: 'cli_tool_use',
        id: itemId || undefined,
        toolName: 'web_search',
        title: typeof item.query === 'string' ? `web_search ${(item.query as string).slice(0, 50)}` : undefined,
        args: { query: item.query },
      });
    }
  }

  /**
   * Post-parse buffered (non-streaming) CLI output into tool events so
   * buffer-at-end tools don't produce silent zero-event runs. vibe's JSON
   * message array carries `tool_calls` on assistant messages and role:"tool"
   * results; agy emits plain text, so a final summary event is the best we
   * can do.
   */
  postParseBufferedEvents(toolName: string, rawStdout: string): void {
    if (toolName === 'Mistral Vibe') {
      let data: unknown;
      try {
        data = JSON.parse(rawStdout);
      } catch {
        return; // plain-text/partial output — nothing structured to surface
      }
      if (!Array.isArray(data)) return;
      for (const msg of data as Array<Record<string, unknown>>) {
        if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
            const fn = tc?.function as Record<string, unknown> | undefined;
            const name = (fn?.name || tc?.name || 'tool') as string;
            const id = (tc?.id || '') as string;
            if (id) this.toolNamesById.set(id, name);
            let args: unknown = fn?.arguments ?? tc?.arguments;
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { /* keep raw string */ }
            }
            this.callbacks.onToolCall?.();
            this.emit('action', { type: 'cli_tool_use', id: id || undefined, toolName: name, args });
          }
        }
        if (msg?.role === 'tool') {
          const id = (msg.tool_call_id || '') as string;
          this.emit('action', {
            type: 'cli_tool_result',
            id: id || undefined,
            toolName: this.toolNamesById.get(id) || 'tool',
            output: typeof msg.content === 'string' ? (msg.content as string).slice(0, 2000) : '',
            isError: false,
          });
        }
      }
      return;
    }

    if (toolName === 'Antigravity') {
      // agy --print is plain text with no tool telemetry; surface a final
      // summary event so the run isn't a silent zero-event blob.
      const summary = rawStdout.trim().slice(0, 500);
      if (summary) this.emit('thought', { status: 'completed', summary });
    }
  }
}

/** Flatten a Claude tool_result block's content (string or content-block array) to text. */
function claudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
        ? String((b as Record<string, unknown>).text ?? '')
        : ''))
      .join('');
  }
  return '';
}

/**
 * Token totals of a muse `run.usage` payload's `models[]`. `cached_tokens` is
 * a subset of `input_tokens` (Meta API, OpenAI shape — folded like codex).
 */
export function museUsage(models: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null {
  if (!Array.isArray(models)) return null;
  const sum = (key: string) => models.reduce((n: number, m) => n + (typeof m?.[key] === 'number' ? m[key] as number : 0), 0);
  const folded = foldCacheCounters({ input_tokens: sum('input_tokens'), input_tokens_details: { cached_tokens: sum('cached_tokens') } });
  return { inputTokens: folded.inputTokens, outputTokens: sum('output_tokens'), cacheReadTokens: folded.cacheReadTokens ?? 0 };
}

/**
 * The allowance of a muse `run.usage` payload or MSP `usage/changed`:
 * `{ window, weekly }`, each with a used percentage and reset. Reports the fuller window (the one that
 * blocks first) and its reset; null when the payload carries none (API-key
 * runs, the echo provider).
 */
export function museAllowance(allowance: unknown): { usedPercent: number; resetsAt?: Date } | null {
  if (!allowance || typeof allowance !== 'object') return null;
  // `muse exec` spells the members snake_case, MSP `usage/changed` camelCase.
  const periods = ['window', 'weekly'].map(key => (allowance as Record<string, Record<string, unknown> | undefined>)[key])
    .map(p => ({ used: p?.used_percent ?? p?.usedPercent, resets: p?.resets_at_ms ?? p?.resetsAtMs }))
    .filter((p): p is { used: number; resets: unknown } => typeof p.used === 'number');
  if (!periods.length) return null;
  // The fuller window blocks first; at a tie, the later reset is when work can resume.
  const fullest = periods.reduce((a, b) => b.used > a.used || (b.used === a.used && Number(b.resets ?? 0) > Number(a.resets ?? 0)) ? b : a);
  return { usedPercent: fullest.used, ...(typeof fullest.resets === 'number' ? { resetsAt: new Date(fullest.resets) } : {}) };
}

/** Display name for a codex mcp_tool_call item: "server.tool". */
function codexMcpToolName(item: Record<string, unknown>): string {
  const server = item.server as string | undefined;
  const tool = item.tool as string | undefined;
  return [server, tool].filter(Boolean).join('.') || 'mcp_tool';
}

/** Codex also sends this startup advisory as an error-shaped JSON event. */
export function isCodexHookTrustWarning(message: string): boolean {
  return /^(?:WARNING:\s*)?`?--dangerously-bypass-hook-trust`? is enabled\. Enabled hooks may run without review for this invocation\.$/i.test(message.trim());
}
