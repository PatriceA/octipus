import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir, } from 'os';
import { isAbsolute, join, resolve } from 'path';
import type { CLIAgentConfig } from '@/db/schema/models';
import { computeLineDiff } from '@/shared/diff';
import { coreLogger } from '@/utils/logger';
import type { AgentEvent } from './agent-base';

const IS_WIN = process.platform === 'win32';

/** How to launch the Octipus MCP server as a stdio child of a CLI tool. */
interface OctipusMcpLaunch {
  /** Runtime to exec — 'node' for the compiled bundle, 'bun' for source. */
  runtime: string;
  /** Absolute path to the MCP server entry point. */
  entry: string;
  /** Loopback URL the MCP server should call back into. */
  apiUrl: string;
  /** Scoped API token (may be '' before the server has booted). */
  apiKey: string;
}

/**
 * Resolve how to launch Octipus's MCP server from the project root. Shared by
 * the Claude JSON config generator and the vibe TOML/VIBE_HOME generator so the
 * runtime/entry/port/token resolution lives in exactly one place.
 */
function resolveOctipusMcpLaunch(): OctipusMcpLaunch {
  const projectRoot = resolve(join(import.meta.dir, '../..'));
  const mcpServerEntry = join(projectRoot, 'mcp-server/dist/index.js');
  const mcpServerSrc = join(projectRoot, 'mcp-server/src/index.ts');

  // Prefer compiled, fall back to source (bun can run .ts).
  const entry = existsSync(mcpServerEntry) ? mcpServerEntry : mcpServerSrc;
  const runtime = existsSync(mcpServerEntry) ? 'node' : 'bun';

  const apiPort = process.env.API_PORT || process.env.PORT || '3005';
  // Only a scoped API token is accepted by the server now (the MASTER_KEY
  // fallback was removed with single-user mode). The backend process does NOT
  // carry OCTIPUS_API_KEY in its env (bin/octi only stamps it into the static
  // CLI config files), so for octipus-spawned CLI subagents we fall back to the
  // bootstrap token the server mints on boot (~/.octipus/mcp-token). Without
  // this, the ephemeral MCP config is keyless and every tool call hits the REST
  // API anonymously → 401.
  const apiKey = process.env.OCTIPUS_API_KEY || readMcpBootstrapToken();

  return { runtime, entry, apiUrl: `http://127.0.0.1:${apiPort}`, apiKey };
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

/**
 * Delete files matching `prefix` in `dir` that are older than `maxAgeMs`.
 * Best-effort retention sweep for ephemeral config/prompt dumps.
 */
export function sweepStaleFiles(dir: string, prefix: string, maxAgeMs: number): void {
  try {
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
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
function getOrCreateMcpConfig(agentId?: string): string | null {
  const dir = join(tmpdir(), 'octipus-cli');
  const suffix = agentId || randomBytes(6).toString('hex');
  const configPath = join(dir, `mcp-config-${suffix}.json`);

  const launch = resolveOctipusMcpLaunch();

  const config = {
    mcpServers: {
      octipus: {
        command: launch.runtime,
        args: [launch.entry],
        env: {
          OCTIPUS_URL: launch.apiUrl,
          ...(launch.apiKey ? { OCTIPUS_API_KEY: launch.apiKey } : {}),
        },
      },
    },
  };

  mkdirSync(dir, { recursive: true });
  sweepStaleFiles(dir, 'mcp-config-', 7 * 24 * 3600_000);
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

/**
 * Inject (or replace) a top-level `mcp_servers` assignment in a vibe
 * `config.toml` with one that registers the Octipus MCP server. vibe's schema
 * makes `mcp_servers` a list, and the default config writes it as an inline
 * empty array (`mcp_servers = []`) — so we replace that single-line assignment
 * with an inline array-of-tables. (A `[[mcp_servers]]` table block would
 * collide with the existing `mcp_servers = []` and be a TOML redefinition.)
 */
export function injectVibeMcpServer(config: string, launch: OctipusMcpLaunch): string {
  // JSON.stringify produces TOML-valid string/array literals for our values
  // (double-quoted strings, `["..."]` arrays).
  const command = JSON.stringify(launch.runtime);
  const argsArr = JSON.stringify([launch.entry]);
  const env = launch.apiKey
    ? `, env = { OCTIPUS_URL = ${JSON.stringify(launch.apiUrl)}, OCTIPUS_API_KEY = ${JSON.stringify(launch.apiKey)} }`
    : `, env = { OCTIPUS_URL = ${JSON.stringify(launch.apiUrl)} }`;
  const assignment =
    `mcp_servers = [\n` +
    `  { name = "octipus", transport = "stdio", command = ${command}, args = ${argsArr}${env} },\n` +
    `]`;

  // Replace an existing single-line inline `mcp_servers = [ ... ]` assignment.
  if (/^mcp_servers\s*=\s*\[.*\]\s*$/m.test(config)) {
    return config.replace(/^mcp_servers\s*=\s*\[.*\]\s*$/m, assignment);
  }
  // No inline assignment found (e.g. user uses [[mcp_servers]] tables) — append.
  return `${config.trimEnd()}\n${assignment}\n`;
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
function getOrCreateVibeHome(): string | null {
  const realHome = process.env.VIBE_HOME || join(homedir(), '.vibe');
  const realConfig = join(realHome, 'config.toml');
  // Nothing to seed if vibe was never set up — let vibe fall back to defaults
  // (it will still run, just without the Octipus MCP server).
  if (!existsSync(realConfig)) return null;

  const dir = join(tmpdir(), 'octipus-cli', `vibe-home-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });

    // Seed creds + trust list into the fresh dir so vibe finds the API key.
    const realEnv = join(realHome, '.env');
    if (existsSync(realEnv)) copyFileSync(realEnv, join(dir, '.env'));
    const realTrust = join(realHome, 'trusted_folders.toml');
    if (existsSync(realTrust)) copyFileSync(realTrust, join(dir, 'trusted_folders.toml'));

    // Write config.toml with a fresh MCP launch (entry/port/token) merged in.
    const launch = resolveOctipusMcpLaunch();
    const merged = injectVibeMcpServer(readFileSync(realConfig, 'utf-8'), launch);
    writeFileSync(join(dir, 'config.toml'), merged);
    return dir;
  } catch (err) {
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
  const cmd = inner.split(/\s+/)[0]?.replace(/^.*\//, '') || 'shell';
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
const CLAUDE_NATIVE_PERMS = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

const CODEX_PERM_MAP: Record<CLIPermissionLevel, string> = {
  safe: 'read-only',
  workspace: 'workspace-write',
  full: 'danger-full-access',
};
const CODEX_NATIVE_PERMS = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export function resolveClaudePermissionMode(mode: string | undefined): string {
  if (!mode) return CLAUDE_PERM_MAP.full; // historical default for spawned agents
  if (mode in CLAUDE_PERM_MAP) return CLAUDE_PERM_MAP[mode as CLIPermissionLevel];
  if (CLAUDE_NATIVE_PERMS.has(mode)) return mode;
  throw new Error(
    `Invalid permissionMode "${mode}" for Claude Code — use 'safe'|'workspace'|'full' or a native Claude mode (${[...CLAUDE_NATIVE_PERMS].join(', ')})`,
  );
}

export function resolveCodexSandboxMode(mode: string | undefined): string {
  if (!mode) return CODEX_PERM_MAP.workspace; // historical default for spawned agents
  if (mode in CODEX_PERM_MAP) return CODEX_PERM_MAP[mode as CLIPermissionLevel];
  if (CODEX_NATIVE_PERMS.has(mode)) return mode;
  throw new Error(
    `Invalid permissionMode "${mode}" for Codex CLI — use 'safe'|'workspace'|'full' or a native codex sandbox (${[...CODEX_NATIVE_PERMS].join(', ')})`,
  );
}

/**
 * Builds CLI arguments for different agent tools (Claude Code, Antigravity, Codex, Mistral Vibe).
 *
 * On Windows, prompts are piped via stdin (not as args) because shell: true
 * is required for .cmd wrappers but mangles long/special-char arguments.
 * When stdinPrompt is returned, the caller must write it to proc.stdin.
 */
export class CLIArgumentBuilder {
  build(
    toolName: string,
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
    systemPrompt?: string | null,
    maxTokenBudget?: number,
    agentId?: string,
  ): { binary: string; args: string[]; stdinPrompt?: string; useShell?: boolean; env?: Record<string, string> } {
    // `toolName` is the CLIToolConfig.adapter key (defaults to name). Vendors
    // that reuse the Claude binary (z.ai GLM, Moonshot Kimi) pass 'Claude Code'.
    switch (toolName) {
      case 'Claude Code':
        return this.buildClaudeArgs(prompt, settings, systemMessages, agentId);
      case 'Antigravity':
        return this.buildAntigravityArgs(prompt, settings, systemPrompt);
      case 'Codex CLI':
        return this.buildCodexArgs(prompt, systemPrompt, settings);
      case 'Mistral Vibe':
        return this.buildVibeArgs(prompt, settings, maxTokenBudget);
      default:
        throw new Error(`Unknown CLI tool: ${toolName}`);
    }
  }

  private buildVibeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    maxTokenBudget?: number,
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

    args.push('--output', 'json', '--trust', '--auto-approve');

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
    const vibeHome = getOrCreateVibeHome();
    const env = vibeHome ? { VIBE_HOME: vibeHome } : undefined;

    return {
      binary: 'vibe',
      args,
      stdinPrompt: IS_WIN ? prompt : undefined,
      env,
    };
  }

  private buildClaudeArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemMessages: string[],
    agentId?: string,
  ): { binary: string; args: string[]; stdinPrompt?: string } {
    // Claude Code: -p is a boolean flag (print mode), prompt is positional
    // On Windows: pipe prompt via stdin to avoid shell mangling
    const args: string[] = [];

    if (IS_WIN) {
      args.push('-p', '--verbose', '--output-format', 'stream-json');
    } else {
      args.push('-p', prompt, '--verbose', '--output-format', 'stream-json');
    }

    // Note: do NOT pass --bare. It explicitly disables OAuth and keychain
    // reads ("Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper"),
    // which makes the spawned subprocess return "Not logged in · Please run
    // /login" for users authenticated via `claude login` (OAuth). Plugin/hook
    // leakage from the host config is the accepted trade-off.

    // Shared 'safe'|'workspace'|'full' levels translate per adapter (C14);
    // native Claude modes pass through, codex-style values throw.
    args.push('--permission-mode', resolveClaudePermissionMode(settings.permissionMode));

    // Model override: env var > settings > vendor default. Vendor accepts an
    // alias ('sonnet', 'opus') or a full model id ('claude-sonnet-4-6').
    // https://code.claude.com/docs/en/cli-reference
    const claudeModel = process.env.CLAUDE_MODEL || settings.model;
    if (claudeModel) {
      args.push('--model', claudeModel);
    }

    if (systemMessages.length > 0) {
      const sysPrompt = systemMessages.join('\n');
      if (IS_WIN) {
        // Write to temp file to avoid Windows command-line length limit (~8191 chars)
        const tmpFile = this.writeTempFile('claude-sys-', sysPrompt);
        args.push('--append-system-prompt-file', tmpFile);
      } else {
        args.push('--append-system-prompt', sysPrompt);
      }
    }

    // MCP config: prefer explicit setting, otherwise auto-generate
    const mcpConfig = settings.mcpConfigPath || getOrCreateMcpConfig(agentId);
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig);
    }

    if (settings.allowedTools?.length) {
      args.push('--allowedTools', ...settings.allowedTools);
    }

    if (settings.maxBudgetUsd != null) {
      args.push('--max-budget-usd', String(settings.maxBudgetUsd));
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    return { binary: 'claude', args, stdinPrompt: IS_WIN ? prompt : undefined };
  }

  private buildAntigravityArgs(
    prompt: string,
    settings: CLIAgentConfig,
    systemPrompt?: string | null,
  ): { binary: string; args: string[]; useShell?: boolean } {
    // agy (Antigravity) replaces the Gemini CLI. `--print <prompt>` runs a
    // single prompt non-interactively and emits PLAIN TEXT (no -o json /
    // stream-json), which the worker buffers via CLIToolConfig.bufferOutput.
    // --dangerously-skip-permissions auto-approves tool calls (the agy
    // equivalent of gemini's --approval-mode yolo).
    const args: string[] = ['--dangerously-skip-permissions'];

    // Model override: env var > settings. agy uses --model (not gemini's -m);
    // when unset, agy picks the model from its own ~/.gemini config.
    const model = process.env.ANTIGRAVITY_MODEL || process.env.GEMINI_MODEL || settings.model;
    if (model) {
      args.push('--model', model);
    }

    if (settings.extraArgs?.length) {
      args.push(...settings.extraArgs);
    }

    // agy has no --system-prompt flag. Prepend the expert system prompt to the
    // user prompt; the worker also writes it to GEMINI.md (which agy reads).
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
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  private buildCodexArgs(
    prompt: string,
    systemPrompt?: string | null,
    settings?: CLIAgentConfig,
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
    const codexPermMode = resolveCodexSandboxMode(settings?.permissionMode);
    const baseArgs = [
      'exec',
      '--skip-git-repo-check',
      '--json',
      '--ephemeral',
      '--sandbox', codexPermMode,
    ];
    if (modelOverride) baseArgs.push('-c', `model="${modelOverride}"`);
    if (settings?.extraArgs?.length) baseArgs.push(...settings.extraArgs);

    if (systemPrompt) {
      const combined = `${systemPrompt}\n\n---\n\n${prompt}`;
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
  /**
   * A model turn started (codex `turn.started`, a new Claude assistant
   * message). The worker uses this as the iteration counter — turns, not
   * tool calls (C15).
   */
  onTurn: () => void;
  /** A tool invocation was observed (separate from turns). */
  onToolCall?: () => void;
  /**
   * Incremental token usage (codex per-turn `turn.completed`, Claude
   * per-assistant-message usage + final `result` reconciliation). Fires
   * per turn so the worker's budget-kill can trigger mid-run (C16).
   */
  onTokenUsage?: (tokens: { input: number; output: number; total: number }) => void;
  /** Authoritative final turn count (Claude `result.num_turns`). */
  onTurnCount?: (turns: number) => void;
  /**
   * The CLI reported the run failed (Claude `error_max_turns` /
   * `error_during_execution` / `is_error`, codex `turn.failed` / `error`).
   * The worker must surface a failed status, never success (C3).
   */
  onRunError?: (reason: string) => void;
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
export class CLIOutputParser {
  /** tool id → tool name, so results can carry the real name (C9). */
  private toolNamesById = new Map<string, string>();
  /** codex item ids we already emitted a cli_tool_use for. */
  private startedItemIds = new Set<string>();
  /** Claude assistant message ids already counted as turns. */
  private seenClaudeMessageIds = new Set<string>();
  /** Tokens already reported via onTokenUsage (for final reconciliation). */
  private reportedTokens = 0;

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

  private emitFileChange(change: { action: string; path: string; content?: string; oldContent?: string; diff?: { patch: string; added: number; removed: number } }): void {
    this.emitFn('action', {
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
      return this.parseClaudeEvent(event, type);
    }

    // Antigravity (agy) emits plain text buffered at process close
    // (CLIToolConfig.bufferOutput), so it has no per-event stream parser here.

    if (toolName === 'Codex CLI') {
      return this.parseCodexEvent(event, type);
    }

    return null;
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
        this.emitFn('thought', {
          status: 'running',
          sessionId: event.session_id,
        });
      }
      return null;
    }

    if (type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      // A new assistant message = a new model turn (deduped by message id —
      // stream-json can re-emit the same message across partials).
      const messageId = message?.id as string | undefined;
      if (!messageId || !this.seenClaudeMessageIds.has(messageId)) {
        if (messageId) this.seenClaudeMessageIds.add(messageId);
        this.callbacks.onTurn();
      }

      // Emit tool_use events — carrying Claude's own tool_use.id so the
      // matching tool_result (type:"user") flips the same row (C1).
      for (const block of content) {
        if (block.type === 'tool_use') {
          this.callbacks.onToolCall?.();
          const toolUseId = (block.id || '') as string;
          const toolName = block.name as string;
          if (toolUseId) this.toolNamesById.set(toolUseId, toolName);
          const input = (block.input || {}) as Record<string, unknown>;
          this.emitFn('action', {
            type: 'cli_tool_use',
            id: toolUseId || undefined,
            toolName,
            args: block.input,
          });
          this.emitClaudeFileChanges(toolName, input);
        }
      }

      // Per-message usage — lets the token budget fire mid-run (C16).
      this.reportClaudeUsage(message?.usage as Record<string, unknown> | undefined);

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
        this.emitFn('action', {
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
      const result = (event.result || '') as string;
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
      this.emitFn('thought', {
        status: isError ? 'failed' : 'completed',
        sessionId: event.session_id,
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
      const delta = Math.max(0, totalTokens - this.reportedTokens);
      if (delta > 0) {
        this.reportedTokens += delta;
        this.callbacks.onTokenUsage?.({ input: inputTokens + cacheRead + cacheCreation, output: outputTokens, total: delta });
      }

      if (isError) {
        const reason =
          subtype === 'error_max_turns'
            ? `Claude Code hit the max-turns limit${numTurns != null ? ` (${numTurns} turns)` : ''}`
            : subtype === 'error_during_execution'
              ? 'Claude Code failed during execution'
              : `Claude Code reported an error${subtype ? ` (${subtype})` : ''}`;
        this.callbacks.onRunError?.(result ? `${reason}: ${result.slice(0, 500)}` : reason);
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

  /** Report per-assistant-message usage, tracking the running total for the final reconciliation. */
  private reportClaudeUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    const input = ((usage.input_tokens || 0) as number)
      + ((usage.cache_read_input_tokens || 0) as number)
      + ((usage.cache_creation_input_tokens || 0) as number);
    const output = (usage.output_tokens || 0) as number;
    const total = input + output;
    if (total <= 0) return;
    this.reportedTokens += total;
    this.callbacks.onTokenUsage?.({ input, output, total });
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

    if (type === 'thread.started') {
      this.emitFn('thought', {
        status: 'running',
        sessionId: event.thread_id,
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
        return text ? { text, replace: true } : null;
      }

      if (itemType === 'reasoning') {
        const text = (item.text || '') as string;
        if (text) this.emitFn('thought', { text: text.slice(0, 2000) });
        return null;
      }

      // Some item types complete without a preceding item.started — make
      // sure the UI still gets a start row before the result flips it.
      if (!this.startedItemIds.has(itemId)) this.emitCodexItemStart(item);

      if (itemType === 'command_execution') {
        const output = (item.aggregated_output || '') as string;
        const exitCode = item.exit_code as number | null;
        this.emitFn('action', {
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
        this.emitFn('action', {
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
        this.emitFn('action', {
          type: 'cli_tool_result',
          id: itemId || undefined,
          toolName: this.toolNamesById.get(itemId) || codexMcpToolName(item),
          output: typeof item.result === 'string' ? (item.result as string).slice(0, 2000) : (failed ? 'failed' : 'ok'),
          isError: failed,
        });
        return null;
      }

      if (itemType === 'web_search') {
        this.emitFn('action', {
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
        this.emitFn('error', { error: message });
        this.callbacks.onRunError?.(message);
        return null;
      }

      return null;
    }

    if (type === 'turn.completed') {
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens = (usage.input_tokens || 0) as number;
        const cachedTokens = (usage.cached_input_tokens || 0) as number;
        const outputTokens = (usage.output_tokens || 0) as number;
        const totalTokens = inputTokens + outputTokens;
        this.emitFn('thought', {
          status: 'completed',
          stats: {
            totalTokens,
            inputTokens,
            outputTokens,
            cacheRead: cachedTokens,
          },
        });
        this.reportedTokens += totalTokens;
        this.callbacks.onTokenUsage?.({ input: inputTokens + cachedTokens, output: outputTokens, total: totalTokens });
      }
      return null;
    }

    if (type === 'turn.failed') {
      const error = event.error as Record<string, unknown> | undefined;
      const message = (error?.message || 'codex turn failed') as string;
      this.emitFn('error', { error: message });
      this.emitFn('thought', { status: 'failed', error: message });
      this.callbacks.onRunError?.(message);
      return null;
    }

    if (type === 'error') {
      const message = (event.message || 'codex reported an error') as string;
      this.emitFn('error', { error: message });
      this.callbacks.onRunError?.(message);
      return null;
    }

    return null;
  }

  /** Emit the cli_tool_use start row for a codex item (idempotent per item id). */
  private emitCodexItemStart(item: Record<string, unknown>): void {
    const itemType = item.type as string;
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
      this.emitFn('action', {
        type: 'cli_tool_use',
        id: itemId || undefined,
        toolName,
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
      this.emitFn('action', {
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
      this.emitFn('action', {
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
      this.emitFn('action', {
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
            this.emitFn('action', { type: 'cli_tool_use', id: id || undefined, toolName: name, args });
          }
        }
        if (msg?.role === 'tool') {
          const id = (msg.tool_call_id || '') as string;
          this.emitFn('action', {
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
      if (summary) this.emitFn('thought', { status: 'completed', summary });
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

/** Display name for a codex mcp_tool_call item: "server.tool". */
function codexMcpToolName(item: Record<string, unknown>): string {
  const server = item.server as string | undefined;
  const tool = item.tool as string | undefined;
  return [server, tool].filter(Boolean).join('.') || 'mcp_tool';
}
